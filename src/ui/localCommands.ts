export type LocalCommand =
	| {
			type: "enter_plan_mode";
	  }
	| {
			type: "resume";
			sessionId: string;
	  }
	| {
			type: "memory";
	  }
	| {
			type: "invalid";
			message: string;
	  }
	| {
			type: "unknown";
			name: string;
	  };

export function parseLocalCommand(input: string): LocalCommand | undefined {
	const trimmed = input.trim();
	if (!trimmed.startsWith("/")) {
		return undefined;
	}

	if (trimmed === "/plan") {
		return { type: "enter_plan_mode" };
	}

	if (trimmed === "/memory") {
		return { type: "memory" };
	}

	const [rawName, ...args] = trimmed.split(/\s+/);
	const name = rawName ?? "";

	if (name === "/resume") {
		const [sessionId, ...rest] = args;
		if (!sessionId || rest.length > 0) {
			return {
				type: "invalid",
				message: "usage: /resume <session-id>",
			};
		}

		return {
			type: "resume",
			sessionId,
		};
	}

	return {
		type: "unknown",
		name,
	};
}
