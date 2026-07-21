mod protocol;

#[cfg(windows)]
mod windows;

use protocol::EnforcementSummary;
use protocol::MAX_REQUEST_BYTES;
use protocol::PROTOCOL_VERSION;
use protocol::SandboxRequest;
use protocol::SandboxResponse;
use protocol::SandboxSuccess;
use std::io::Read;

fn main() {
    let response = run();
    let failed = matches!(response.status, protocol::ResponseStatus::Error);
    match serde_json::to_string(&response) {
        Ok(json) => println!("{json}"),
        Err(error) => {
            eprintln!("failed to serialize sandbox response: {error}");
            std::process::exit(2);
        }
    }
    if failed {
        std::process::exit(1);
    }
}

fn run() -> SandboxResponse {
    let request = match read_request(std::io::stdin()) {
        Ok(request) => request,
        Err(response) => return *response,
    };
    let request_id = request.request_id.clone();
    let enforcement = EnforcementSummary::for_execution_mode(request.execution_mode);

    #[cfg(windows)]
    {
        match windows::run(request) {
            Ok(result) => SandboxResponse::success(
                request_id,
                SandboxSuccess {
                    exit_code: result.exit_code,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    timed_out: result.timed_out,
                    stdout_truncated: result.stdout_truncated,
                    stderr_truncated: result.stderr_truncated,
                    shell: result.shell,
                },
                enforcement,
            ),
            Err(error) => SandboxResponse::error_with_enforcement(
                request_id,
                error.stage,
                error.message,
                error.windows_error_code,
                enforcement,
            ),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = request;
        SandboxResponse::error_with_enforcement(
            request_id,
            "platform",
            "the native sandbox runner only supports Windows",
            None,
            enforcement,
        )
    }
}

fn read_request<R: Read>(reader: R) -> Result<SandboxRequest, Box<SandboxResponse>> {
    let mut bytes = Vec::new();
    if let Err(error) = reader.take(MAX_REQUEST_BYTES + 1).read_to_end(&mut bytes) {
        return Err(Box::new(SandboxResponse::error(
            "",
            "read_request",
            error.to_string(),
            None,
        )));
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(Box::new(SandboxResponse::error(
            "",
            "validate_request",
            "sandbox request exceeds 1 MiB",
            None,
        )));
    }

    let request: SandboxRequest = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(error) => {
            return Err(Box::new(SandboxResponse::error(
                "",
                "parse_request",
                error.to_string(),
                None,
            )));
        }
    };
    let request_id = request.request_id.clone();
    if request.version != PROTOCOL_VERSION {
        return Err(Box::new(SandboxResponse::error(
            request_id,
            "validate_request",
            format!(
                "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                request.version
            ),
            None,
        )));
    }

    Ok(request)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use serde_json::json;

    fn valid_request_value() -> Value {
        json!({
            "version": PROTOCOL_VERSION,
            "request_id": "request-1",
            "parent_pid": 1,
            "execution_mode": "workspace_write",
            "args": [],
            "cwd": "C:/workspace",
            "writable_roots": ["C:/workspace"],
            "env": {},
            "timeout_ms": 100,
            "max_output_bytes": 1024
        })
    }

    fn request_bytes(value: &Value) -> Vec<u8> {
        serde_json::to_vec(value).expect("serialize test request")
    }

    fn expect_error(result: Result<SandboxRequest, Box<SandboxResponse>>) -> SandboxResponse {
        match result {
            Ok(_) => panic!("request unexpectedly succeeded"),
            Err(response) => *response,
        }
    }

    fn assert_error(response: &SandboxResponse, request_id: &str, stage: &str) {
        assert!(matches!(response.status, protocol::ResponseStatus::Error));
        assert_eq!(response.request_id, request_id);
        let error = response.error.as_ref().expect("error payload");
        assert_eq!(error.stage, stage);
        assert!(error.windows_error_code.is_none());
    }

    #[test]
    fn malformed_json_is_a_parse_error() {
        let response = expect_error(read_request(&b"{"[..]));

        assert_error(&response, "", "parse_request");
    }

    #[test]
    fn unknown_field_is_a_parse_error() {
        let mut request = valid_request_value();
        request
            .as_object_mut()
            .expect("request object")
            .insert("unexpected".to_owned(), json!(true));

        let response = expect_error(read_request(request_bytes(&request).as_slice()));

        assert_error(&response, "", "parse_request");
    }

    #[test]
    fn duplicate_field_is_a_parse_error() {
        let request = br#"{
            "version": 3,
            "version": 3,
            "request_id": "request-1",
            "parent_pid": 1,
            "cwd": "C:/workspace",
            "writable_roots": ["C:/workspace"],
            "timeout_ms": 100,
            "max_output_bytes": 1024
        }"#;

        let response = expect_error(read_request(request.as_slice()));

        assert_error(&response, "", "parse_request");
    }

    #[test]
    fn unsupported_version_is_a_validation_error() {
        let mut request = valid_request_value();
        request["version"] = json!(PROTOCOL_VERSION + 1);

        let response = expect_error(read_request(request_bytes(&request).as_slice()));

        assert_error(&response, "request-1", "validate_request");
        assert!(
            response
                .error
                .as_ref()
                .expect("error payload")
                .message
                .contains("unsupported protocol version")
        );
    }

    #[test]
    fn request_size_limit_is_inclusive() {
        let mut bytes = request_bytes(&valid_request_value());
        bytes.resize(MAX_REQUEST_BYTES as usize, b' ');

        assert!(read_request(bytes.as_slice()).is_ok());

        bytes.push(b' ');
        let response = expect_error(read_request(bytes.as_slice()));
        assert_error(&response, "", "validate_request");
        assert_eq!(
            response.error.as_ref().expect("error payload").message,
            "sandbox request exceeds 1 MiB"
        );
    }
}
