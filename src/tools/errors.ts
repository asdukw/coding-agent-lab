import { WindowsSandboxError } from "../sandbox";
import type { ToolFailure } from "../state";

const SANDBOX_REQUEST_ERROR_STAGES = new Set([
	"validate_request",
	"validate_cwd",
	"validate_path",
	"workspace_binding",
]);

export class ToolFailureError extends Error {
	readonly failure: ToolFailure;
	readonly details?: string;

	constructor(
		failure: ToolFailure,
		options: { cause?: unknown; details?: string } = {},
	) {
		super(failure.message, { cause: options.cause });
		this.name = "ToolFailureError";
		this.failure = { ...failure };
		this.details = options.details;
	}
}

export function classifyToolFailure(caught: unknown): {
	failure: ToolFailure;
	details?: string;
} {
	if (caught instanceof ToolFailureError) {
		return { failure: { ...caught.failure }, details: caught.details };
	}

	if (caught instanceof WindowsSandboxError) {
		return {
			failure: {
				// Once a validated Shell request crosses into the Windows sandbox,
				// helper, protocol, token, ACL, process, and poisoned-state failures all
				// mean that the execution backend was unavailable. Only caller/request
				// validation errors remain ordinary runtime errors.
				kind: SANDBOX_REQUEST_ERROR_STAGES.has(caught.stage)
					? "runtime_error"
					: "backend_unavailable",
				message: caught.message,
				stage: caught.stage,
			},
		};
	}

	const message = caught instanceof Error ? caught.message : String(caught);
	return {
		failure: {
			kind: "runtime_error",
			message,
			...(caught instanceof Error && caught.name === "AbortError"
				? { stage: "aborted" }
				: {}),
		},
	};
}
