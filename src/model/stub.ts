import type { ModelClient, ModelRequest, ModelStreamEvent } from "./client";

export class StubModelClient implements ModelClient {
	readonly name = "stub";

	async *stream(request: ModelRequest): AsyncGenerator<ModelStreamEvent> {
		const lastMessage = request.messages.at(-1);
		yield {
			type: "text_delta",
			content: `Stub agent received task: ${lastMessage?.content ?? ""}`,
		};
	}
}
