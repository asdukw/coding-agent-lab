import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WindowsSandboxOptions } from "./types";
import {
	createWindowsSandbox,
	type WindowsSandbox,
	WindowsSandboxError,
} from "./windowsSandbox";

let configuredRoot: string | undefined;
let configuredRootKey: string | undefined;
let singleton: Promise<WindowsSandbox> | undefined;

/**
 * Bind the process to one workspace sandbox. A later attempt to switch roots
 * fails closed instead of silently expanding the writable boundary.
 */
export function getWindowsSandbox(
	cwd: string,
	options: WindowsSandboxOptions = {},
): Promise<WindowsSandbox> {
	const workspaceRoot = getWindowsSandboxWorkspaceRoot(cwd);
	singleton ??= createWindowsSandbox(workspaceRoot, options);
	return singleton;
}

export function initializeWindowsSandbox(
	workspaceRoot: string,
	options: WindowsSandboxOptions = {},
): Promise<WindowsSandbox> {
	const requestedRoot = resolve(workspaceRoot);
	if (configuredRootKey && configuredRootKey !== normalizePath(requestedRoot)) {
		return Promise.reject(workspaceBindingError(requestedRoot));
	}
	configuredRoot = requestedRoot;
	configuredRootKey = normalizePath(requestedRoot);
	singleton ??= createWindowsSandbox(requestedRoot, options);
	return singleton;
}

/**
 * Return the immutable writable root for resource planning. The CLI must bind
 * it during startup; silently deriving a root from restored runtime state would
 * let untrusted session data expand the filesystem boundary.
 */
export function getWindowsSandboxWorkspaceRoot(cwd: string): string {
	const requestedCwd = resolve(cwd);
	if (!configuredRoot || !configuredRootKey) {
		throw new WindowsSandboxError(
			"The Windows sandbox workspace has not been initialized at startup.",
			{ stage: "workspace_binding" },
		);
	}
	if (!isPathInside(normalizePath(requestedCwd), configuredRootKey)) {
		throw workspaceBindingError(requestedCwd);
	}
	return configuredRoot;
}

function normalizePath(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

function isPathInside(path: string, parent: string): boolean {
	const rel = relative(parent, path);
	return (
		rel === "" ||
		(!!rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
	);
}

function workspaceBindingError(requestedPath: string): WindowsSandboxError {
	return new WindowsSandboxError(
		`Path is outside the fixed Windows sandbox workspace (${configuredRoot ?? "unbound"}): ${requestedPath}`,
		{ stage: "workspace_binding" },
	);
}

export * from "./types";
export {
	createWindowsSandbox,
	WindowsSandbox,
	WindowsSandboxError,
} from "./windowsSandbox";
