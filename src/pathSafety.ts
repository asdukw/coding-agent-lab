import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

class PathSafetyError extends Error {}

export async function resolveContainedWritePath(params: {
	targetPath: string;
	directoryPath: string;
	boundaryPath?: string;
}): Promise<string> {
	const targetPath = resolve(params.targetPath);
	const directoryPath = resolve(params.directoryPath);
	const boundaryPath = resolve(params.boundaryPath ?? directoryPath);

	if (!isPathInside(targetPath, directoryPath)) {
		throw new Error(`Path escapes allowed directory: ${params.targetPath}`);
	}

	const [realBoundary, realDirectory, realTarget] = await Promise.all([
		resolveRealPathForWrite(boundaryPath),
		resolveRealPathForWrite(directoryPath),
		resolveRealPathForWrite(targetPath),
	]);
	if (!isPathInside(realDirectory, realBoundary)) {
		throw new Error(`Allowed directory escapes its boundary: ${directoryPath}`);
	}
	if (!isPathInside(realTarget, realDirectory)) {
		throw new Error(
			`Path escapes allowed directory via symlink: ${params.targetPath}`,
		);
	}

	await assertNoSymlinkFromDirectory(directoryPath, targetPath);
	return targetPath;
}

export function isPathInside(targetPath: string, parentPath: string): boolean {
	const child = resolve(targetPath);
	const parent = resolve(parentPath);
	const rel = relative(parent, child);
	return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export async function resolveRealPathForWrite(path: string): Promise<string> {
	const tail: string[] = [];
	let current = resolve(path);

	for (;;) {
		try {
			const existing = await realpath(current);
			return tail.length > 0 ? resolve(existing, ...tail.reverse()) : existing;
		} catch (caught) {
			const code = getErrnoCode(caught);
			if (code === "ELOOP") {
				throw new Error(
					`Cannot verify path because of a symlink loop: ${path}`,
				);
			}
			if (!["ENOENT", "ENOTDIR", "ENAMETOOLONG"].includes(code ?? "")) {
				throw new Error(
					`Cannot verify path containment (${code ?? "unknown"}): ${path}`,
				);
			}

			try {
				const entry = await lstat(current);
				if (entry.isSymbolicLink()) {
					throw new PathSafetyError(
						`Cannot write through a dangling symlink: ${current}`,
					);
				}
			} catch (lstatError) {
				if (lstatError instanceof PathSafetyError) {
					throw lstatError;
				}
				const lstatCode = getErrnoCode(lstatError);
				if (lstatCode && !["ENOENT", "ENOTDIR"].includes(lstatCode)) {
					throw new Error(
						`Cannot inspect path containment (${lstatCode}): ${current}`,
					);
				}
			}

			const parent = dirname(current);
			if (parent === current) {
				throw new Error(`Cannot find an existing ancestor for path: ${path}`);
			}
			tail.push(basename(current));
			current = parent;
		}
	}
}

async function assertNoSymlinkFromDirectory(
	directoryPath: string,
	targetPath: string,
): Promise<void> {
	const rel = relative(directoryPath, targetPath);
	const segments = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
	let current = directoryPath;

	for (const segment of ["", ...segments]) {
		if (segment) {
			current = resolve(current, segment);
		}
		try {
			const entry = await lstat(current);
			if (entry.isSymbolicLink()) {
				throw new PathSafetyError(
					`Writing through symlinks is not allowed: ${current}`,
				);
			}
		} catch (caught) {
			if (caught instanceof PathSafetyError) {
				throw caught;
			}
			const code = getErrnoCode(caught);
			if (code === "ENOENT" || code === "ENOTDIR") {
				return;
			}
			throw new Error(
				`Cannot inspect write path (${code ?? "unknown"}): ${current}`,
			);
		}
	}
}

function getErrnoCode(caught: unknown): string | undefined {
	return caught instanceof Error && "code" in caught
		? String((caught as { code?: unknown }).code)
		: undefined;
}
