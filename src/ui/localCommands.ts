import type { ApprovalMode } from "../state";

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
			type: "open_permissions";
	  }
	| {
			type: "set_permissions";
			mode: ApprovalMode;
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

	if (trimmed === "/permissions") {
		return { type: "open_permissions" };
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

	if (name === "/permissions") {
		const [mode, ...rest] = args;
		const normalizedMode = normalizeApprovalMode(mode);
		if (!normalizedMode || rest.length > 0) {
			return {
				type: "invalid",
				message: "usage: /permissions [ask|auto|full]",
			};
		}
		return { type: "set_permissions", mode: normalizedMode };
	}

	return {
		type: "unknown",
		name,
	};
}

function normalizeApprovalMode(
	value: string | undefined,
): ApprovalMode | undefined {
	if (value === "ask" || value === "auto") {
		return value;
	}
	if (value === "full" || value === "full_access") {
		return "full_access";
	}
	return undefined;
}
