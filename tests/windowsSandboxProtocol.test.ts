import { expect, test } from "bun:test";
import { WINDOWS_SANDBOX_PROTOCOL_VERSION } from "../src/sandbox/types";
import {
	parseNativeResponse,
	WindowsSandboxError,
} from "../src/sandbox/windowsSandbox";

const REQUEST_ID = "legacy-helper-request";
const LEGACY_V2_PROTOCOL_MISMATCH = {
	status: "error",
	request_id: REQUEST_ID,
	exit_code: null,
	stdout: "",
	stderr: "",
	timed_out: false,
	stdout_truncated: false,
	stderr_truncated: false,
	error: {
		stage: "validate_request",
		message: `unsupported protocol version ${WINDOWS_SANDBOX_PROTOCOL_VERSION}; expected 2`,
		windows_error_code: null,
	},
	enforcement: {
		filesystem: "write_restricted_acl",
		process_tree: "job_members_kill_on_close",
		network: "inherited_not_isolated",
	},
};

test("legacy v2 helper mismatch has an actionable diagnostic", () => {
	const mismatch = captureSandboxError(LEGACY_V2_PROTOCOL_MISMATCH);
	expect(mismatch.stage).toBe("helper_protocol_mismatch");
	expect(mismatch.message).toContain("`bun run build:sandbox`");

	const malformed = captureSandboxError({
		...LEGACY_V2_PROTOCOL_MISMATCH,
		unexpected: true,
	});
	expect(malformed.stage).toBe("validate_response");
});

function captureSandboxError(response: object): WindowsSandboxError {
	try {
		parseNativeResponse(
			JSON.stringify(response),
			REQUEST_ID,
			"workspace_write",
		);
	} catch (caught) {
		expect(caught).toBeInstanceOf(WindowsSandboxError);
		return caught as WindowsSandboxError;
	}
	throw new Error("Expected the sandbox response to be rejected.");
}
