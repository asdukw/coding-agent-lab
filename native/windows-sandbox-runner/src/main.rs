mod protocol;

#[cfg(windows)]
mod windows;

use protocol::MAX_REQUEST_BYTES;
use protocol::PROTOCOL_VERSION;
use protocol::SandboxRequest;
use protocol::SandboxResponse;
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
    let mut bytes = Vec::new();
    if let Err(error) = std::io::stdin()
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
    {
        return SandboxResponse::error("", "read_request", error.to_string(), None);
    }
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return SandboxResponse::error(
            "",
            "validate_request",
            "sandbox request exceeds 1 MiB",
            None,
        );
    }

    let request: SandboxRequest = match serde_json::from_slice(&bytes) {
        Ok(request) => request,
        Err(error) => {
            return SandboxResponse::error("", "parse_request", error.to_string(), None);
        }
    };
    let request_id = request.request_id.clone();
    if request.version != PROTOCOL_VERSION {
        return SandboxResponse::error(
            request_id,
            "validate_request",
            format!(
                "unsupported protocol version {}; expected {PROTOCOL_VERSION}",
                request.version
            ),
            None,
        );
    }

    #[cfg(windows)]
    {
        match windows::run(request) {
            Ok(result) => SandboxResponse::success(
                request_id,
                result.exit_code,
                result.stdout,
                result.stderr,
                result.timed_out,
                result.stdout_truncated,
                result.stderr_truncated,
            ),
            Err(error) => SandboxResponse::error(
                request_id,
                error.stage,
                error.message,
                error.windows_error_code,
            ),
        }
    }

    #[cfg(not(windows))]
    {
        let _ = request;
        SandboxResponse::error(
            request_id,
            "platform",
            "the native sandbox runner only supports Windows",
            None,
        )
    }
}
