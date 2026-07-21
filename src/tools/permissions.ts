import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { isMemoryIndexPath, resolveMemoryWriteTarget } from "../memory";
import {
	isPathInside,
	resolveContainedWritePath,
	resolveRealPathForWrite,
} from "../pathSafety";
import {
	type AgentState,
	hasDangerFullAccess,
	permissionPolicyForMode,
} from "../state";
import {
	CANCEL_AGENT_TOOL_NAME,
	LIST_AGENTS_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
} from "./agentToolNames";
import { ToolFailureError } from "./errors";
import {
	ENTER_PLAN_MODE_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
} from "./planToolNames";
import { SHELL_TOOL_NAME } from "./shellTool";
import type { Tool, Tools } from "./types";

const READ_ONLY_TOOL_NAMES = new Set(["Read", "Glob", "Grep"]);
const GENERIC_WRITE_TOOL_NAMES = new Set(["Write", "Edit"]);
const PLAN_ONLY_TOOL_NAMES = new Set([
	EXIT_PLAN_MODE_TOOL_NAME,
	UPDATE_PLAN_TOOL_NAME,
]);
const PLAN_MODE_TOOL_NAMES = new Set([
	"Read",
	"Glob",
	"Grep",
	UPDATE_PLAN_TOOL_NAME,
	EXIT_PLAN_MODE_TOOL_NAME,
	ENTER_PLAN_MODE_TOOL_NAME,
	LIST_AGENTS_TOOL_NAME,
	WAIT_AGENT_TOOL_NAME,
	SEND_AGENT_MESSAGE_TOOL_NAME,
	CANCEL_AGENT_TOOL_NAME,
]);

export type ToolPermissionDecision =
	| { kind: "allow" }
	| { kind: "ask"; reason: string }
	| { kind: "deny"; reason: string };

export function getToolsForMode(state: AgentState, tools: Tools): Tools {
	if (state.toolPermissionContext.mode !== "plan") {
		return tools.filter(
			(tool) =>
				!PLAN_ONLY_TOOL_NAMES.has(tool.name) &&
				(tool.name !== SHELL_TOOL_NAME || isPrivilegedMainToolAllowed(state)) &&
				(!isMcpTool(tool) || isPrivilegedMainToolAllowed(state)),
		);
	}

	return tools.filter((tool) => {
		if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
			return false;
		}
		return PLAN_MODE_TOOL_NAMES.has(tool.name);
	});
}

export async function getToolPermissionDecision(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
	callId?: string,
): Promise<ToolPermissionDecision> {
	try {
		await enforceToolBoundary(state, tool, args);
	} catch (caught) {
		return { kind: "deny", reason: formatCaught(caught) };
	}

	if (!requiresInteractiveApproval(state, tool, args)) {
		return { kind: "allow" };
	}

	const approval = approvalForCall(state, tool.name, args, callId);
	if (approval === "allow") {
		return { kind: "allow" };
	}
	if (approval === "deny") {
		return { kind: "deny", reason: `User denied ${tool.name}` };
	}
	return { kind: "ask", reason: approvalReason(tool, args) };
}

export async function authorizeToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
	callId?: string,
): Promise<void> {
	const decision = await getToolPermissionDecision(state, tool, args, callId);
	if (decision.kind === "allow") {
		return;
	}
	if (decision.kind === "ask") {
		const message = `${tool.name} requires user approval: ${decision.reason}`;
		throw new ToolFailureError({
			kind: "permission_denied",
			message,
			stage: "approval_required",
		});
	}
	throw new ToolFailureError({
		kind: "permission_denied",
		message: decision.reason,
		stage:
			decision.reason === `User denied ${tool.name}` ? "user_denied" : "policy",
	});
}

export function isProtectedWorkspacePath(
	workspaceRoot: string,
	targetPath: string,
	_agentType: AgentState["toolPermissionContext"]["agentType"] = "main",
): boolean {
	const root = resolve(workspaceRoot);
	const target = resolve(targetPath);
	if (!isPathInside(target, root)) {
		return true;
	}
	if (isPathInside(target, resolve(root, ".cagent", "memory"))) {
		return false;
	}

	const rel = relative(root, target);
	const segments = rel.split(/[\\/]+/).filter(Boolean);
	if (
		process.platform === "win32" &&
		segments.some((segment) => segment.includes(":"))
	) {
		return true;
	}
	return segments.some((segment) => {
		const normalized = segment.toLowerCase();
		return (
			normalized === ".git" ||
			normalized === ".cagent" ||
			normalized === ".cagent-sandbox" ||
			/^\.env(?:[.:]|$)/i.test(segment)
		);
	});
}

export async function isSafeWorkspaceReadPath(
	workspaceRoot: string,
	targetPath: string,
	agentType: AgentState["toolPermissionContext"]["agentType"] = "main",
	dangerFullAccess = false,
): Promise<boolean> {
	try {
		if (dangerFullAccess && agentType === "main") {
			await lstat(targetPath);
			return true;
		}
		const [canonicalRoot, canonicalTarget] = await Promise.all([
			resolveRealPathForWrite(workspaceRoot),
			resolveRealPathForWrite(targetPath),
		]);
		const entry = await lstat(canonicalTarget);
		return (
			isPathInside(canonicalTarget, canonicalRoot) &&
			!isProtectedWorkspacePath(canonicalRoot, canonicalTarget, agentType) &&
			(!entry.isFile() || entry.nlink === 1)
		);
	} catch {
		return false;
	}
}

export function toolArgumentFingerprint(args: Record<string, unknown>): string {
	return stableStringify(args);
}

async function enforceToolBoundary(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): Promise<void> {
	if (state.toolPermissionContext.mode !== "plan") {
		if (PLAN_ONLY_TOOL_NAMES.has(tool.name)) {
			throw new Error(`${tool.name} can only be used in plan mode`);
		}
		if (READ_ONLY_TOOL_NAMES.has(tool.name)) {
			await authorizeReadToolCall(state, tool, args);
		}
		if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
			if (
				state.toolPermissionContext.agentType === "subagent" &&
				!state.toolPermissionContext.sessionAllowedTools.includes(tool.name)
			) {
				throw new Error(
					`${tool.name} was not delegated to this sub-agent by the main session`,
				);
			}
			await authorizeWriteToolCall(state, tool, args);
		}
		if (
			(tool.name === SHELL_TOOL_NAME || isMcpTool(tool)) &&
			!isPrivilegedMainToolAllowed(state)
		) {
			throw new Error(`${tool.name} is only available to the main agent`);
		}
		return;
	}

	if (READ_ONLY_TOOL_NAMES.has(tool.name)) {
		await authorizeReadToolCall(state, tool, args);
		return;
	}
	if (
		tool.name === ENTER_PLAN_MODE_TOOL_NAME ||
		tool.name === EXIT_PLAN_MODE_TOOL_NAME ||
		tool.name === UPDATE_PLAN_TOOL_NAME ||
		tool.name === LIST_AGENTS_TOOL_NAME ||
		tool.name === WAIT_AGENT_TOOL_NAME ||
		tool.name === SEND_AGENT_MESSAGE_TOOL_NAME ||
		tool.name === CANCEL_AGENT_TOOL_NAME
	) {
		return;
	}
	if (GENERIC_WRITE_TOOL_NAMES.has(tool.name)) {
		throw new Error("Plan mode cannot write local files; use UpdatePlan");
	}
	throw new Error(`${tool.name} is not allowed in plan mode`);
}

async function authorizeReadToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): Promise<void> {
	const argumentName = tool.name === "Read" ? "file_path" : "path";
	const rawPath = args[argumentName] ?? ".";
	if (typeof rawPath !== "string" || rawPath.trim() === "") {
		throw new Error(`${tool.name} requires a valid ${argumentName}`);
	}
	const targetPath = resolvePath(state.cwd, rawPath);
	if (hasDangerFullAccess(state)) {
		args[argumentName] = targetPath;
		return;
	}
	const [canonicalRoot, canonicalTarget] = await Promise.all([
		resolveRealPathForWrite(state.cwd),
		resolveRealPathForWrite(targetPath),
	]);
	if (!isPathInside(canonicalTarget, canonicalRoot)) {
		throw new Error(
			`${tool.name} cannot read outside the workspace: ${rawPath}`,
		);
	}
	if (
		isProtectedWorkspacePath(
			canonicalRoot,
			canonicalTarget,
			state.toolPermissionContext.agentType,
		)
	) {
		throw new Error(`${tool.name} cannot access protected path: ${rawPath}`);
	}
	if (tool.name === "Read") {
		await assertSingleLinkReadTarget(canonicalTarget, rawPath);
	}
	args[argumentName] = targetPath;
}

async function authorizeWriteToolCall(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): Promise<void> {
	const filePath = args.file_path;
	if (typeof filePath !== "string" || filePath.trim() === "") {
		throw new Error(`${tool.name} requires a file_path for permission checks`);
	}

	let targetPath = resolvePath(state.cwd, filePath);
	if (state.toolPermissionContext.agentType === "memory") {
		const memoryDir = resolve(state.cwd, ".cagent", "memory");
		try {
			targetPath = await resolveContainedWritePath({
				targetPath,
				directoryPath: memoryDir,
				boundaryPath: state.cwd,
			});
		} catch {
			throw new Error(
				"Memory sub agent can only write files under .cagent/memory",
			);
		}
		if (isMemoryIndexPath(targetPath)) {
			throw new Error("MEMORY.md is managed automatically after extraction");
		}
		args.file_path = targetPath;
		return;
	}

	args.file_path = targetPath;
	if (hasDangerFullAccess(state)) {
		return;
	}
	const canonicalTarget = await resolveRealPathForWrite(targetPath);
	const canonicalRoot = await resolveRealPathForWrite(state.cwd);
	await assertNoMultiHardlink(targetPath, tool.name);
	if (isMemoryIndexPath(canonicalTarget)) {
		throw new Error("MEMORY.md is managed automatically after extraction");
	}
	if (isProtectedWorkspacePath(canonicalRoot, canonicalTarget)) {
		throw new Error(`${tool.name} cannot modify protected path: ${filePath}`);
	}

	const policy = state.toolPermissionContext.writePolicy;
	if (!policy) {
		throw new Error(`${tool.name} has no write policy`);
	}
	const memoryTarget = await resolveMemoryWriteTarget(state.cwd, targetPath);
	const policyTargets = uniquePaths(
		memoryTarget ? [canonicalTarget, memoryTarget] : [canonicalTarget],
	);

	const deniedRoots = await resolvePolicyRoots(state.cwd, policy.deny ?? []);
	const denied = policyTargets.some((candidate) =>
		deniedRoots.some((root) => isPathInside(candidate, root)),
	);
	if (denied) {
		throw new Error(`${tool.name} denied by write policy: ${filePath}`);
	}

	if (policy.allow && policy.allow.length > 0) {
		const allowedRoots = await resolvePolicyRoots(state.cwd, policy.allow);
		const allowed = policyTargets.every((candidate) =>
			allowedRoots.some((root) => isPathInside(candidate, root)),
		);
		if (!allowed) {
			throw new Error(`${tool.name} is outside the workspace: ${filePath}`);
		}
	}
}

function requiresInteractiveApproval(
	state: AgentState,
	tool: Tool,
	args: Record<string, unknown>,
): boolean {
	if (
		state.toolPermissionContext.mode !== "normal" ||
		state.toolPermissionContext.agentType !== "main"
	) {
		return false;
	}
	const policy = permissionPolicyForMode(
		state.toolPermissionContext.approvalMode,
	);
	if (policy.approval === "never") {
		return false;
	}
	if (policy.approval === "ask_on_risk") {
		// Auto mode follows a sandbox-first flow: bounded Shell calls run without a
		// prompt, while an explicit sandbox bypass and opaque external side effects
		// remain escalation points.
		return isSandboxBypass(tool.name, args) || isMcpTool(tool);
	}
	return (
		GENERIC_WRITE_TOOL_NAMES.has(tool.name) ||
		tool.name === SHELL_TOOL_NAME ||
		isMcpTool(tool)
	);
}

function approvalForCall(
	state: AgentState,
	toolName: string,
	args: Record<string, unknown>,
	callId: string | undefined,
): "allow" | "deny" | undefined {
	const pending = state.toolPermissionContext.pendingToolApproval;
	// A writable session file cannot carry an approval decision across restore.
	// Rebuild the complete request set before accepting a fresh user decision.
	if (pending?.needsRevalidation) {
		return undefined;
	}
	if (pending?.decision) {
		if (
			callId === undefined ||
			!pending.calls.some(
				(call) => call.id === callId && call.name === toolName,
			)
		) {
			return undefined;
		}
		const fingerprint = toolArgumentFingerprint(args);
		const request = pending.requests.find(
			(candidate) =>
				candidate.callId === callId &&
				candidate.toolName === toolName &&
				candidate.argumentFingerprint === fingerprint &&
				candidate.argumentFingerprint ===
					toolArgumentFingerprint(candidate.args),
		);
		if (!request) {
			return undefined;
		}
		if (pending.decision === "deny") {
			return "deny";
		}
		if (
			pending.decision === "allow_once" ||
			pending.decision === "allow_session"
		) {
			return "allow";
		}
		return undefined;
	}
	if (
		state.toolPermissionContext.sessionAllowedTools.includes(toolName) &&
		!isSandboxBypass(toolName, args)
	) {
		return "allow";
	}
	return undefined;
}

function approvalReason(tool: Tool, args: Record<string, unknown>): string {
	if (tool.name === SHELL_TOOL_NAME) {
		if (isSandboxBypass(tool.name, args)) {
			return "requests execution outside the workspace sandbox with the host user's filesystem, environment, and network authority";
		}
		return "executes a PowerShell command that can read host-user files, write in the workspace, and use inherited network access";
	}
	if (isMcpTool(tool)) {
		return "calls an external MCP tool whose side effects are not controlled by the workspace sandbox";
	}
	return `${tool.name} modifies files in the workspace`;
}

function isSandboxBypass(
	toolName: string,
	args: Record<string, unknown>,
): boolean {
	return (
		toolName === SHELL_TOOL_NAME && args.dangerously_disable_sandbox === true
	);
}

function isPrivilegedMainToolAllowed(state: AgentState): boolean {
	return state.toolPermissionContext.agentType === "main";
}

function isMcpTool(tool: Tool): boolean {
	return tool.name.startsWith("mcp__");
}

async function resolvePolicyRoots(
	cwd: string,
	entries: string[],
): Promise<string[]> {
	return Promise.all(
		entries.map((entry) => resolveRealPathForWrite(resolvePath(cwd, entry))),
	);
}

function uniquePaths(paths: string[]): string[] {
	const normalize = (path: string) =>
		process.platform === "win32" ? path.toLowerCase() : path;
	const seen = new Set<string>();
	return paths.filter((path) => {
		const key = normalize(path);
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? resolve(path) : resolve(cwd, path);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}

async function assertNoMultiHardlink(
	targetPath: string,
	toolName: string,
): Promise<void> {
	try {
		const entry = await lstat(targetPath);
		if (entry.isFile() && entry.nlink > 1) {
			throw new Error(
				`${toolName} cannot modify a file with multiple hard links: ${targetPath}`,
			);
		}
	} catch (caught) {
		if (
			caught instanceof Error &&
			"code" in caught &&
			caught.code === "ENOENT"
		) {
			return;
		}
		throw caught;
	}
}

async function assertSingleLinkReadTarget(
	targetPath: string,
	displayPath: string,
): Promise<void> {
	try {
		const entry = await lstat(targetPath);
		if (entry.isFile() && entry.nlink !== 1) {
			throw new Error(
				`Read cannot access a file with multiple hard links: ${displayPath}`,
			);
		}
	} catch (caught) {
		if (
			caught instanceof Error &&
			"code" in caught &&
			caught.code === "ENOENT"
		) {
			return;
		}
		throw caught;
	}
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(stableStringify).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}
