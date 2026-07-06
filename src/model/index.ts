import type { ModelClient } from "./client";
import { DeepSeekModelClient } from "./deepseek";
import { StubModelClient } from "./stub";

export function createModelClientFromEnv(): ModelClient {
	const deepSeekApiKey = process.env.DEEPSEEK_API_KEY;
	if (!deepSeekApiKey) {
		return new StubModelClient();
	}

	return new DeepSeekModelClient({
		apiKey: deepSeekApiKey,
		baseURL: process.env.DEEPSEEK_BASE_URL,
		model: process.env.DEEPSEEK_MODEL,
	});
}
