import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverMcpTools, type McpClientConnection } from "../src/mcp/client";
import { toToolSpec } from "../src/tools/types";

async function makeTempDir(): Promise<string> {
	return mkdtemp(join(tmpdir(), "cagent-mcp-"));
}

test("discovers stdio MCP tools and registers their original schema", async () => {
	const cwd = await makeTempDir();
	const calls: { name: string; arguments: Record<string, unknown> }[] = [];
	let closed = false;

	try {
		await mkdir(join(cwd, ".cagent"));
		await writeFile(
			join(cwd, ".cagent", "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"demo server": {
						command: "unused-in-test",
						args: ["--stdio"],
					},
				},
			}),
		);

		const connection: McpClientConnection = {
			async listTools() {
				return {
					tools: [
						{
							name: "echo.tool",
							description: "Echo a message",
							inputSchema: {
								type: "object",
								properties: { message: { type: "string" } },
								required: ["message"],
							},
							annotations: { readOnlyHint: true },
						},
					],
				};
			},
			async callTool(input) {
				calls.push(input);
				return { content: [{ type: "text", text: "hello" }] };
			},
			async close() {
				closed = true;
			},
		};

		const discovery = await discoverMcpTools(cwd, async () => connection);
		expect(discovery.diagnostics).toEqual([]);
		expect(discovery.tools).toHaveLength(1);

		const [tool] = discovery.tools;
		if (!tool) {
			throw new Error("expected the discovered MCP tool");
		}
		expect(tool?.name).toBe("mcp__demo_server__echo_tool");
		expect(tool?.isReadOnly).toBe(true);
		expect(toToolSpec(tool)).toEqual({
			name: "mcp__demo_server__echo_tool",
			description: "Echo a message",
			inputSchema: {
				type: "object",
				properties: { message: { type: "string" } },
				required: ["message"],
			},
		});

		await tool?.call({ message: "hi" });
		expect(calls).toEqual([
			{ name: "echo.tool", arguments: { message: "hi" } },
		]);

		await discovery.close();
		expect(closed).toBe(true);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("keeps cagent available when an MCP server cannot connect", async () => {
	const cwd = await makeTempDir();
	try {
		await mkdir(join(cwd, ".cagent"));
		await writeFile(
			join(cwd, ".cagent", "mcp.json"),
			JSON.stringify({
				mcpServers: { unavailable: { command: "does-not-exist" } },
			}),
		);

		const discovery = await discoverMcpTools(cwd, async () => {
			throw new Error("connection refused");
		});

		expect(discovery.tools).toEqual([]);
		expect(discovery.diagnostics).toEqual([
			'MCP server "unavailable" was skipped: connection refused',
		]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});

test("reads only the cagent MCP config path", async () => {
	const cwd = await makeTempDir();
	try {
		await writeFile(
			join(cwd, ".mcp.json"),
			JSON.stringify({
				mcpServers: { ignored: { command: "unused-in-test" } },
			}),
		);

		const discovery = await discoverMcpTools(cwd, async () => {
			throw new Error("the root config must not be read");
		});

		expect(discovery.tools).toEqual([]);
		expect(discovery.diagnostics).toEqual([]);
	} finally {
		await rm(cwd, { recursive: true, force: true });
	}
});
