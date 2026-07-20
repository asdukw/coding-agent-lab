import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEMO_FILE_PATH = "src/price.ts";
export const DEMO_BROKEN_EXPRESSION = "1 + discountPercent / 100";
export const DEMO_FIXED_EXPRESSION = "1 - discountPercent / 100";
export const DEMO_FIXTURE_DIRECTORY = fileURLToPath(
	new URL("../../examples/offline-demo/fixture/", import.meta.url),
);
export const DEMO_FIXTURE_FILE = join(DEMO_FIXTURE_DIRECTORY, DEMO_FILE_PATH);
