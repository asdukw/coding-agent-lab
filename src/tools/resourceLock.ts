import { stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { resolveRealPathForWrite } from "../pathSafety";

export type ResourceMode = "read" | "write";
export type ResourceScope = "exact" | "subtree";
export type ResourceNamespace =
	| "fs"
	| "fs-identity"
	| "session"
	| "memory"
	| "mcp"
	| "runtime";

export type ResourceAccess = {
	namespace: ResourceNamespace;
	key: string;
	mode: ResourceMode;
	scope?: ResourceScope;
};

type ActiveLease = {
	id: number;
	accesses: ResourceAccess[];
};

type PendingLease = {
	id: number;
	accesses: ResourceAccess[];
	resolve(release: () => void): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
};

/**
 * Process-local, atomic multi-resource reader/writer lock.
 * Requests acquire their whole access set at once, so callers never deadlock
 * by taking individual locks in different orders.
 */
export class RuntimeResourceLock {
	private nextId = 1;
	private readonly active = new Map<number, ActiveLease>();
	private readonly pending: PendingLease[] = [];

	acquire(
		accesses: readonly ResourceAccess[],
		signal?: AbortSignal,
	): Promise<() => void> {
		const normalized = normalizeAccesses(accesses);
		if (normalized.length === 0) {
			return Promise.resolve(() => undefined);
		}
		if (signal?.aborted) {
			return Promise.reject(new Error("resource lock acquisition aborted"));
		}

		return new Promise<() => void>((resolveLease, rejectLease) => {
			const request: PendingLease = {
				id: this.nextId++,
				accesses: normalized,
				resolve: resolveLease,
				reject: rejectLease,
				signal,
			};
			if (signal) {
				request.onAbort = () => {
					const index = this.pending.indexOf(request);
					if (index >= 0) {
						this.pending.splice(index, 1);
						rejectLease(new Error("resource lock acquisition aborted"));
						this.schedule();
					}
				};
				signal.addEventListener("abort", request.onAbort, { once: true });
			}
			this.pending.push(request);
			this.schedule();
		});
	}

	private schedule(): void {
		for (;;) {
			let granted = false;
			for (let index = 0; index < this.pending.length; index++) {
				const request = this.pending[index];
				if (!request) {
					continue;
				}
				const conflictsWithActive = [...this.active.values()].some((lease) =>
					accessSetsConflict(request.accesses, lease.accesses),
				);
				const conflictsWithEarlier = this.pending
					.slice(0, index)
					.some((earlier) =>
						accessSetsConflict(request.accesses, earlier.accesses),
					);
				if (conflictsWithActive || conflictsWithEarlier) {
					continue;
				}

				this.pending.splice(index, 1);
				if (request.signal && request.onAbort) {
					request.signal.removeEventListener("abort", request.onAbort);
				}
				this.active.set(request.id, {
					id: request.id,
					accesses: request.accesses,
				});
				let released = false;
				request.resolve(() => {
					if (released) {
						return;
					}
					released = true;
					this.active.delete(request.id);
					this.schedule();
				});
				granted = true;
				break;
			}
			if (!granted) {
				return;
			}
		}
	}
}

export const runtimeResourceLock = new RuntimeResourceLock();

export async function fileResourceAccesses(
	path: string,
	mode: ResourceMode,
	scope: ResourceScope = "exact",
): Promise<ResourceAccess[]> {
	const canonicalPath = normalizePath(await resolveRealPathForWrite(path));
	const accesses: ResourceAccess[] = [
		{ namespace: "fs", key: canonicalPath, mode, scope },
	];
	if (scope === "exact") {
		try {
			const identity = await stat(path, { bigint: true });
			if (identity.ino !== 0n) {
				accesses.push({
					namespace: "fs-identity",
					key: `${identity.dev}:${identity.ino}`,
					mode,
					scope: "exact",
				});
			}
		} catch {
			// A not-yet-created path is protected by its canonical path key.
		}
	}
	return accesses;
}

export function sessionResourceAccess(
	sessionId: string,
	mode: ResourceMode,
): ResourceAccess {
	return {
		namespace: "session",
		key: sessionId,
		mode,
		scope: "exact",
	};
}

export async function memoryResourceAccess(
	cwd: string,
	mode: ResourceMode,
): Promise<ResourceAccess> {
	return {
		namespace: "memory",
		key: normalizePath(await resolveRealPathForWrite(cwd)),
		mode,
		scope: "exact",
	};
}

export function opaqueToolAccess(mode: ResourceMode = "write"): ResourceAccess {
	return {
		namespace: "runtime",
		key: "opaque-tools",
		mode,
		scope: "exact",
	};
}

export function resourceAccessSetsEqual(
	left: readonly ResourceAccess[],
	right: readonly ResourceAccess[],
): boolean {
	const leftKeys = normalizedAccessKeys(left);
	const rightKeys = normalizedAccessKeys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every((key, index) => key === rightKeys[index])
	);
}

export function resolveToolPath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function normalizeAccesses(
	accesses: readonly ResourceAccess[],
): ResourceAccess[] {
	const normalized = new Map<string, ResourceAccess>();
	for (const access of accesses) {
		const scope = access.scope ?? "exact";
		const key = `${access.namespace}\u0000${access.key}\u0000${scope}`;
		const previous = normalized.get(key);
		normalized.set(key, {
			...access,
			scope,
			mode:
				previous?.mode === "write" || access.mode === "write"
					? "write"
					: "read",
		});
	}
	return [...normalized.values()];
}

function normalizedAccessKeys(accesses: readonly ResourceAccess[]): string[] {
	return normalizeAccesses(accesses)
		.map((access) =>
			JSON.stringify([
				access.namespace,
				access.key,
				access.mode,
				access.scope ?? "exact",
			]),
		)
		.sort();
}

function accessSetsConflict(
	left: readonly ResourceAccess[],
	right: readonly ResourceAccess[],
): boolean {
	return left.some((first) =>
		right.some(
			(second) =>
				(first.mode === "write" || second.mode === "write") &&
				resourcesOverlap(first, second),
		),
	);
}

function resourcesOverlap(
	left: ResourceAccess,
	right: ResourceAccess,
): boolean {
	if (left.namespace !== right.namespace) {
		return false;
	}
	if (left.key === right.key) {
		return true;
	}
	if (left.namespace !== "fs") {
		return false;
	}
	return (
		(left.scope === "subtree" && isPathWithin(right.key, left.key)) ||
		(right.scope === "subtree" && isPathWithin(left.key, right.key))
	);
}

function isPathWithin(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return (
		rel === "" ||
		(!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function normalizePath(path: string): string {
	const normalized = resolve(path);
	return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
