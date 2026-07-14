import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

const MCP_CONFIG_FILE = ".cagent/mcp.json";

const stdioServerSchema = z.object({
	type: z.literal("stdio").optional(),
	command: z.string().min(1, "command cannot be empty"),
	args: z.array(z.string()).default([]),
	env: z.record(z.string(), z.string()).optional(),
});

const mcpConfigSchema = z.object({
	mcpServers: z.record(z.string(), stdioServerSchema),
});

export type McpStdioServerConfig = z.infer<typeof stdioServerSchema>;

export type NamedMcpStdioServerConfig = McpStdioServerConfig & {
	name: string;
};

export async function loadMcpServerConfigs(
	cwd: string,
): Promise<NamedMcpStdioServerConfig[]> {
	const configPath = join(cwd, MCP_CONFIG_FILE);
	let raw: string;

	try {
		raw = await readFile(configPath, "utf8");
	} catch (caught) {
		if (isNotFoundError(caught)) {
			return [];
		}
		throw caught;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (caught) {
		throw new Error(`Invalid ${MCP_CONFIG_FILE}: ${formatCaught(caught)}`);
	}

	const result = mcpConfigSchema.safeParse(parsed);
	if (!result.success) {
		throw new Error(
			`Invalid ${MCP_CONFIG_FILE}: ${result.error.issues
				.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
				.join("; ")}`,
		);
	}

	return Object.entries(result.data.mcpServers).map(([name, config]) => ({
		name,
		...config,
	}));
}

function isNotFoundError(caught: unknown): boolean {
	return (
		typeof caught === "object" &&
		caught !== null &&
		"code" in caught &&
		(caught as { code?: unknown }).code === "ENOENT"
	);
}

function formatCaught(caught: unknown): string {
	return caught instanceof Error ? caught.message : String(caught);
}
