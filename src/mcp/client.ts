import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { opaqueToolAccess, type ResourceAccess } from "../tools/resourceLock";
import type { Tool, Tools } from "../tools/types";
import { CAGENT_VERSION } from "../version";
import { loadMcpServerConfigs, type NamedMcpStdioServerConfig } from "./config";

export type McpToolDefinition = {
	name: string;
	description?: string;
	inputSchema: Record<string, unknown>;
	annotations?: {
		readOnlyHint?: boolean;
	};
};

export type McpToolCallResult = {
	content: unknown[];
	isError?: boolean;
	structuredContent?: unknown;
	_meta?: Record<string, unknown>;
};

export type McpClientConnection = {
	listTools(): Promise<{ tools: McpToolDefinition[] }>;
	callTool(
		input: {
			name: string;
			arguments: Record<string, unknown>;
		},
		options?: { signal?: AbortSignal },
	): Promise<McpToolCallResult>;
	close(): Promise<void>;
};

export type ConnectMcpServer = (
	server: NamedMcpStdioServerConfig,
) => Promise<McpClientConnection>;

export type McpDiscovery = {
	tools: Tools;
	diagnostics: string[];
	close(): Promise<void>;
};

const externalInputSchema = z.object({}).passthrough();
const DEFAULT_MCP_DISCOVERY_TIMEOUT_MS = 10_000;
const MCP_INHERITED_ENVIRONMENT_KEYS = [
	"APPDATA",
	"ComSpec",
	"HOME",
	"HOMEDRIVE",
	"HOMEPATH",
	"LANG",
	"LC_ALL",
	"LOCALAPPDATA",
	"NUMBER_OF_PROCESSORS",
	"OS",
	"Path",
	"PATHEXT",
	"ProgramData",
	"ProgramFiles",
	"ProgramFiles(x86)",
	"ProgramW6432",
	"SHELL",
	"SystemDrive",
	"SystemRoot",
	"TEMP",
	"TMP",
	"TMPDIR",
	"USER",
	"USERPROFILE",
	"WINDIR",
] as const;

export async function discoverMcpTools(
	cwd: string,
	connect: ConnectMcpServer = connectStdioMcpServer,
): Promise<McpDiscovery> {
	const servers = await loadMcpServerConfigs(cwd);
	const tools: Tool[] = [];
	const diagnostics: string[] = [];
	const clients: McpClientConnection[] = [];
	const names = new Set<string>();

	for (const server of servers) {
		let client: McpClientConnection | undefined;
		try {
			client = await connect(server);
			const result = await withTimeout(
				client.listTools(),
				`MCP server "${server.name}" tool discovery timed out`,
			);
			clients.push(client);

			for (const definition of result.tools) {
				const tool = toCagentMcpTool(server.name, definition, client);
				if (names.has(tool.name)) {
					throw new Error(`duplicate MCP tool name: ${tool.name}`);
				}
				names.add(tool.name);
				tools.push(tool);
			}
		} catch (caught) {
			await client?.close().catch(() => undefined);
			diagnostics.push(
				`MCP server "${server.name}" was skipped: ${formatCaught(caught)}`,
			);
		}
	}

	return {
		tools,
		diagnostics,
		async close() {
			await Promise.allSettled(clients.map((client) => client.close()));
		},
	};
}

export async function connectStdioMcpServer(
	server: NamedMcpStdioServerConfig,
): Promise<McpClientConnection> {
	const transport = new StdioClientTransport({
		command: server.command,
		args: server.args,
		env: { ...inheritedEnvironment(), ...server.env },
		cwd: process.cwd(),
	});
	const client = new Client(
		{ name: "cagent", version: CAGENT_VERSION },
		{ capabilities: {} },
	);

	try {
		await withTimeout(
			client.connect(transport),
			`MCP server "${server.name}" connection timed out`,
		);
	} catch (caught) {
		await client.close().catch(() => undefined);
		throw caught;
	}

	return {
		async listTools() {
			return client.listTools();
		},
		async callTool(input, options) {
			return toMcpToolCallResult(
				await client.callTool(input, undefined, { signal: options?.signal }),
			);
		},
		async close() {
			await client.close();
		},
	};
}

function toMcpToolCallResult(
	result: Record<string, unknown>,
): McpToolCallResult {
	if (!Array.isArray(result.content)) {
		throw new Error("MCP tool returned an asynchronous task result");
	}

	const output: McpToolCallResult = { content: result.content };
	if (result.isError === true) {
		output.isError = true;
	}
	if ("structuredContent" in result) {
		output.structuredContent = result.structuredContent;
	}
	if (isRecord(result._meta)) {
		output._meta = result._meta;
	}
	return output;
}

function toCagentMcpTool(
	serverName: string,
	definition: McpToolDefinition,
	client: McpClientConnection,
): Tool<Record<string, unknown>, McpToolCallResult> {
	const name = buildMcpToolName(serverName, definition.name);

	return {
		name,
		description: definition.description ?? `MCP tool ${definition.name}`,
		inputSchema: externalInputSchema,
		inputJSONSchema: definition.inputSchema,
		getResourceAccesses() {
			const access: ResourceAccess = {
				namespace: "mcp",
				key: serverName,
				// MCP annotations are supplied by the external server itself. Until a
				// host policy maps a tool to concrete resources, treat every call as
				// opaque and potentially mutating.
				mode: "write",
				scope: "exact",
			};
			return [access, opaqueToolAccess()];
		},
		async call(args, context) {
			const result = await client.callTool(
				{
					name: definition.name,
					arguments: args,
				},
				{ signal: context?.signal },
			);
			if (result.isError) {
				throw new Error(formatMcpError(result));
			}
			return result;
		},
	};
}

function buildMcpToolName(serverName: string, toolName: string): string {
	return `mcp__${normalizeName(serverName)}__${normalizeName(toolName)}`;
}

function normalizeName(name: string): string {
	const normalized = name.replace(/[^a-zA-Z0-9_-]/g, "_");
	if (!normalized) {
		throw new Error("MCP server and tool names must contain valid characters");
	}
	return normalized;
}

function formatMcpError(result: McpToolCallResult): string {
	const text = result.content
		.map((item) => {
			if (
				typeof item === "object" &&
				item !== null &&
				"type" in item &&
				(item as { type?: unknown }).type === "text" &&
				"text" in item &&
				typeof (item as { text?: unknown }).text === "string"
			) {
				return (item as { text: string }).text;
			}
			return JSON.stringify(item);
		})
		.filter(Boolean)
		.join("\n");

	return text || "MCP tool returned an error";
}

function inheritedEnvironment(): Record<string, string> {
	const environment: Record<string, string> = {};
	for (const name of MCP_INHERITED_ENVIRONMENT_KEYS) {
		const value = readEnvironmentValue(name);
		if (value !== undefined && !value.includes("\0")) {
			environment[name] = value;
		}
	}
	environment.CAGENT_MCP = "1";
	return environment;
}

function readEnvironmentValue(name: string): string | undefined {
	const expected = name.toLowerCase();
	for (const [key, value] of Object.entries(process.env)) {
		if (key.toLowerCase() === expected) {
			return value;
		}
	}
	return undefined;
}

function withTimeout<T>(operation: Promise<T>, message: string): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		operation,
		new Promise<never>((_, reject) => {
			timeout = setTimeout(
				() => reject(new Error(message)),
				getMcpDiscoveryTimeoutMs(),
			);
		}),
	]).finally(() => {
		if (timeout) {
			clearTimeout(timeout);
		}
	});
}

function getMcpDiscoveryTimeoutMs(): number {
	const configured = Number.parseInt(
		process.env.MCP_DISCOVERY_TIMEOUT_MS ?? "",
		10,
	);
	return configured > 0 ? configured : DEFAULT_MCP_DISCOVERY_TIMEOUT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
