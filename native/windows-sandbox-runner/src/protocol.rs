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
