import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const ENV_FILE = fileURLToPath(new URL("../../.env", import.meta.url));
const ALLOWED_KEYS = [
	"DEEPSEEK_API_KEY",
	"DEEPSEEK_BASE_URL",
	"DEEPSEEK_MODEL",
] as const;

type AllowedKey = (typeof ALLOWED_KEYS)[number];

export type DeepSeekDotenvResult = {
	fileFound: boolean;
	appliedKeys: AllowedKey[];
};

/**
 * Loads only the DeepSeek settings from this repository's root .env file.
 * Existing parent-process variables win and arbitrary workspace variables are
 * never copied into the Agent process.
 */
export async function loadDeepSeekDotenv(): Promise<DeepSeekDotenvResult> {
	let source: string;
	try {
		source = await readFile(ENV_FILE, "utf8");
	} catch (caught) {
		if (isNotFoundError(caught)) {
			return { fileFound: false, appliedKeys: [] };
		}
		throw new Error("failed to read the repository .env file");
	}

	let parsed: ReturnType<typeof parseEnv>;
	try {
		parsed = parseEnv(source);
	} catch {
		throw new Error("failed to parse the repository .env file");
	}

	const appliedKeys: AllowedKey[] = [];
	for (const key of ALLOWED_KEYS) {
		if (process.env[key] !== undefined || parsed[key] === undefined) {
			continue;
		}
		process.env[key] = parsed[key];
		appliedKeys.push(key);
	}
	return { fileFound: true, appliedKeys };
}

function isNotFoundError(caught: unknown): boolean {
	return (
		caught instanceof Error &&
		"code" in caught &&
		(caught as NodeJS.ErrnoException).code === "ENOENT"
	);
}
