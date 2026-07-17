use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: u64 = 1024 * 1024;
pub const MAX_WRITABLE_ROOTS: usize = 4;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxRequest {
    pub version: u32,
    pub request_id: String,
    pub parent_pid: u32,
    #[serde(default)]
    pub args: Vec<String>,
    pub cwd: String,
    pub writable_roots: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct SandboxResponse {
    pub status: ResponseStatus,
    pub request_id: String,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub error: Option<SandboxError>,
    pub enforcement: EnforcementSummary,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseStatus {
    Ok,
    Error,
}

#[derive(Debug, Serialize)]
pub struct SandboxError {
    pub stage: String,
    pub message: String,
    pub windows_error_code: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct EnforcementSummary {
    pub filesystem: &'static str,
    pub process_tree: &'static str,
    pub network: &'static str,
}

impl EnforcementSummary {
    pub fn windows_v1() -> Self {
        Self {
            filesystem: "write_restricted_acl",
            process_tree: "job_members_kill_on_close",
            network: "inherited_not_isolated",
        }
    }
}

impl SandboxResponse {
    pub fn success(
        request_id: String,
        exit_code: i32,
        stdout: String,
        stderr: String,
        timed_out: bool,
        stdout_truncated: bool,
        stderr_truncated: bool,
    ) -> Self {
        Self {
            status: ResponseStatus::Ok,
            request_id,
            exit_code: Some(exit_code),
            stdout,
            stderr,
            timed_out,
            stdout_truncated,
            stderr_truncated,
            error: None,
            enforcement: EnforcementSummary::windows_v1(),
        }
    }

    pub fn error(
        request_id: impl Into<String>,
        stage: impl Into<String>,
        message: impl Into<String>,
        windows_error_code: Option<u32>,
    ) -> Self {
        Self {
            status: ResponseStatus::Error,
            request_id: request_id.into(),
            exit_code: None,
            stdout: String::new(),
            stderr: String::new(),
            timed_out: false,
            stdout_truncated: false,
            stderr_truncated: false,
            error: Some(SandboxError {
                stage: stage.into(),
                message: message.into(),
                windows_error_code,
            }),
            enforcement: EnforcementSummary::windows_v1(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn minimal_request() -> serde_json::Value {
        json!({
            "version": PROTOCOL_VERSION,
            "request_id": "request-1",
            "parent_pid": 1,
            "cwd": "C:/workspace",
            "writable_roots": ["C:/workspace"],
            "timeout_ms": 100,
            "max_output_bytes": 1024
        })
    }

    #[test]
    fn request_defaults_args_and_environment() {
        let request: SandboxRequest =
            serde_json::from_value(minimal_request()).expect("deserialize request");

        assert!(request.args.is_empty());
        assert!(request.env.is_empty());
    }

    #[test]
    fn request_rejects_unknown_fields() {
        let mut value = minimal_request();
        value
            .as_object_mut()
            .expect("request object")
            .insert("unexpected".to_owned(), json!(true));

        let error = serde_json::from_value::<SandboxRequest>(value)
            .expect_err("unknown field must be rejected");

        assert!(error.to_string().contains("unknown field"));
    }

    #[test]
    fn success_response_serializes_the_protocol_contract() {
        let response = SandboxResponse::success(
            "request-1".to_owned(),
            7,
            "stdout".to_owned(),
            "stderr".to_owned(),
            true,
            true,
            false,
        );

        let value = serde_json::to_value(response).expect("serialize success response");

        assert_eq!(
            value,
            json!({
                "status": "ok",
                "request_id": "request-1",
                "exit_code": 7,
                "stdout": "stdout",
                "stderr": "stderr",
                "timed_out": true,
                "stdout_truncated": true,
                "stderr_truncated": false,
                "error": null,
                "enforcement": {
                    "filesystem": "write_restricted_acl",
                    "process_tree": "job_members_kill_on_close",
                    "network": "inherited_not_isolated"
                }
            })
        );
    }

    #[test]
    fn error_response_serializes_the_protocol_contract() {
        let response =
            SandboxResponse::error("request-1", "create_process", "access denied", Some(5));

        let value = serde_json::to_value(response).expect("serialize error response");

        assert_eq!(
            value,
            json!({
                "status": "error",
                "request_id": "request-1",
                "exit_code": null,
                "stdout": "",
                "stderr": "",
                "timed_out": false,
                "stdout_truncated": false,
                "stderr_truncated": false,
                "error": {
                    "stage": "create_process",
                    "message": "access denied",
                    "windows_error_code": 5
                },
                "enforcement": {
                    "filesystem": "write_restricted_acl",
                    "process_tree": "job_members_kill_on_close",
                    "network": "inherited_not_isolated"
                }
            })
        );
    }
}
