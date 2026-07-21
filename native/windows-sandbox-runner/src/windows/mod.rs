mod handle;
mod process;
mod security;

use crate::protocol::ExecutionMode;
use crate::protocol::MAX_WRITABLE_ROOTS;
use crate::protocol::PowerShellEngine;
use crate::protocol::PowerShellSummary;
use crate::protocol::SandboxRequest;
use process::ProcessSpec;
use security::LocalSid;
use std::collections::BTreeMap;
use std::collections::HashSet;
use std::ffi::OsStr;
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use std::os::windows::fs::MetadataExt;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::path::Prefix;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows_sys::Win32::UI::Shell::CSIDL_PROGRAM_FILES;
use windows_sys::Win32::UI::Shell::SHGFP_TYPE_CURRENT;
use windows_sys::Win32::UI::Shell::SHGetFolderPathW;

const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
const MIN_OUTPUT_BYTES: usize = 1_024;
const MAX_OUTPUT_BYTES: usize = 1_024 * 1_024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ENVIRONMENT_ENTRIES: usize = 4_096;
const MAX_REQUEST_ID_BYTES: usize = 128;
const PROFILE_CREATE_ATTEMPTS: u64 = 64;

static PROFILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
    pub shell: PowerShellSummary,
}

#[derive(Debug)]
struct ResolvedPowerShell {
    executable: PathBuf,
    summary: PowerShellSummary,
}

#[derive(Debug)]
pub struct RunError {
    pub stage: String,
    pub message: String,
    pub windows_error_code: Option<u32>,
}

impl RunError {
    fn validation(message: impl Into<String>) -> Self {
        Self {
            stage: "validate_request".to_owned(),
            message: message.into(),
            windows_error_code: None,
        }
    }

    fn at(stage: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            stage: stage.into(),
            message: message.into(),
            windows_error_code: None,
        }
    }

    fn from_io(stage: &'static str, context: impl AsRef<str>, error: std::io::Error) -> Self {
        Self {
            stage: stage.to_owned(),
            message: format!("{}: {error}", context.as_ref()),
            windows_error_code: error.raw_os_error().map(|code| code as u32),
        }
    }
}

pub fn run(request: SandboxRequest) -> Result<RunResult, RunError> {
    validate_request_shape(&request)?;

    // Pin the caller's process object before doing any durable filesystem work.
    // Keeping this handle open prevents PID reuse from changing which process
    // the runner monitors while it prepares the sandbox.
    let parent = process::ParentProcess::open(request.parent_pid)?;
    let powershell = trusted_powershell_executable()?;
    let cwd = canonical_directory(Path::new(&request.cwd), "cwd")?;

    if matches!(request.execution_mode, ExecutionMode::DangerFullAccess) {
        // Full access deliberately skips every filesystem sandboxing step: no
        // writable-root ACLs, temporary profile, or restricted token. Keep the
        // trusted executable check and the native process boundary so the
        // command still starts suspended with an explicit handle list, is
        // atomically assigned to the kill-on-close Job, and remains subject to
        // the same parent monitoring, timeout, and bounded-output behavior.
        let output = process::run(ProcessSpec {
            parent: &parent,
            token: None,
            executable: &powershell.executable,
            args: &request.args,
            cwd: &cwd,
            env: &request.env,
            timeout_ms: request.timeout_ms,
            max_output_bytes: request.max_output_bytes,
        })?;
        return Ok(RunResult {
            exit_code: output.exit_code,
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            timed_out: output.timed_out,
            stdout_truncated: output.stdout_truncated,
            stderr_truncated: output.stderr_truncated,
            shell: powershell.summary,
        });
    }

    let writable_roots = canonical_writable_roots(&request.writable_roots)?;
    if !writable_roots.iter().any(|root| path_is_within(&cwd, root)) {
        return Err(RunError::validation(format!(
            "cwd must be inside one writable root: {}",
            cwd.display()
        )));
    }

    materialize_cagent_directories(&writable_roots, &parent)?;
    let profile = TemporaryProfile::create(&writable_roots)?;
    parent.ensure_alive()?;
    let mut capability_roots = writable_roots.clone();
    capability_roots.push(profile.root().to_owned());

    let sid_strings = capability_roots
        .iter()
        .map(|root| security::capability_sid_for_root(root))
        .collect::<Vec<_>>();
    let capability_sids = sid_strings
        .iter()
        .map(|sid| {
            LocalSid::from_string(sid)
                .map_err(|error| RunError::at("create_capability_sid", error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;

    for (root, sid) in writable_roots.iter().zip(capability_sids.iter()) {
        let installed = security::write_access_is_present(root, sid).map_err(|error| {
            RunError::at(
                "inspect_workspace_acl",
                format!(
                    "failed to inspect capability access on {}: {error}",
                    root.display()
                ),
            )
        })?;
        validate_workspace_tree(root, !installed, sid, &parent)?;
        if installed {
            // Do not call SetNamedSecurityInfo again: even replacing an
            // equivalent inheritable ACE can re-propagate onto hardlinks or
            // reparse targets created since the initial installation.
            continue;
        }
        parent.ensure_alive()?;
        security::grant_write_access(root, sid).map_err(|error| {
            RunError::at(
                "grant_workspace_acl",
                format!(
                    "failed to grant the capability SID access to {}: {error}",
                    root.display()
                ),
            )
        })?;
    }

    let profile_sid = capability_sids.last().ok_or_else(|| {
        RunError::at(
            "create_restricted_token",
            "temporary profile capability SID is missing",
        )
    })?;
    parent.ensure_alive()?;
    security::grant_write_access(profile.root(), profile_sid).map_err(|error| {
        RunError::at(
            "grant_profile_acl",
            format!(
                "failed to grant the temporary profile capability SID access to {}: {error}",
                profile.root().display()
            ),
        )
    })?;

    // Profile SIDs are intentionally excluded from every persistent workspace
    // deny ACE. They are unique per request and would otherwise grow the DACL
    // without bound; workspace SIDs are stable and path-scoped.
    let workspace_sids = &capability_sids[..writable_roots.len()];
    for (root, sid) in writable_roots.iter().zip(workspace_sids) {
        parent.ensure_alive()?;
        security::deny_root_delete_access(root, sid).map_err(|error| {
            RunError::at(
                "protect_workspace_root_acl",
                format!(
                    "failed to protect workspace root {} from deletion: {error}",
                    root.display()
                ),
            )
        })?;
    }
    parent.ensure_alive()?;
    protect_sensitive_workspace_paths(&writable_roots, workspace_sids)?;
    parent.ensure_alive()?;
    protect_runner_binary(&writable_roots, workspace_sids)?;

    let token = security::create_restricted_token(&capability_sids, profile_sid)
        .map_err(|error| RunError::at("create_restricted_token", error.to_string()))?;
    let mut environment = request.env.clone();
    profile.apply_environment(&mut environment)?;
    let output = process::run(ProcessSpec {
        parent: &parent,
        token: Some(token.raw()),
        executable: &powershell.executable,
        args: &request.args,
        cwd: &cwd,
        env: &environment,
        timeout_ms: request.timeout_ms,
        max_output_bytes: request.max_output_bytes,
    })?;

    Ok(RunResult {
        exit_code: output.exit_code,
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        timed_out: output.timed_out,
        stdout_truncated: output.stdout_truncated,
        stderr_truncated: output.stderr_truncated,
        shell: powershell.summary,
    })
}

fn validate_request_shape(request: &SandboxRequest) -> Result<(), RunError> {
    if request.request_id.is_empty() || request.request_id.len() > MAX_REQUEST_ID_BYTES {
        return Err(RunError::validation(format!(
            "request_id must contain between 1 and {MAX_REQUEST_ID_BYTES} ASCII bytes"
        )));
    }
    reject_nul("request_id", &request.request_id)?;
    if !request
        .request_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':'))
    {
        return Err(RunError::validation(
            "request_id may only contain ASCII letters, digits, '-', '_', '.', and ':'",
        ));
    }
    if request.parent_pid == 0 || request.parent_pid == std::process::id() {
        return Err(RunError::validation(
            "parent_pid must identify a non-zero process other than the sandbox runner",
        ));
    }
    reject_nul("cwd", &request.cwd)?;
    if request.args.len() > MAX_ARGUMENTS {
        return Err(RunError::validation(format!(
            "args exceeds the limit of {MAX_ARGUMENTS} entries"
        )));
    }
    for (index, value) in request.args.iter().enumerate() {
        reject_nul(&format!("args[{index}]"), value)?;
    }
    if request.writable_roots.len() > MAX_WRITABLE_ROOTS {
        return Err(RunError::validation(format!(
            "writable_roots exceeds the limit of {MAX_WRITABLE_ROOTS} entries"
        )));
    }
    for (index, value) in request.writable_roots.iter().enumerate() {
        reject_nul(&format!("writable_roots[{index}]"), value)?;
    }
    if request.env.len() > MAX_ENVIRONMENT_ENTRIES {
        return Err(RunError::validation(format!(
            "env exceeds the limit of {MAX_ENVIRONMENT_ENTRIES} entries"
        )));
    }
    let mut environment_names = HashSet::with_capacity(request.env.len());
    for (name, value) in &request.env {
        if name.is_empty() || name.contains('=') {
            return Err(RunError::validation(format!(
                "environment variable name {name:?} is invalid"
            )));
        }
        reject_nul("environment variable name", name)?;
        reject_nul(&format!("environment variable {name}"), value)?;
        if !environment_names.insert(name.to_lowercase()) {
            return Err(RunError::validation(format!(
                "environment variable {name:?} is duplicated with different casing"
            )));
        }
    }
    if !(MIN_TIMEOUT_MS..=MAX_TIMEOUT_MS).contains(&request.timeout_ms) {
        return Err(RunError::validation(format!(
            "timeout_ms must be between {MIN_TIMEOUT_MS} and {MAX_TIMEOUT_MS}"
        )));
    }
    if !(MIN_OUTPUT_BYTES..=MAX_OUTPUT_BYTES).contains(&request.max_output_bytes) {
        return Err(RunError::validation(format!(
            "max_output_bytes must be between {MIN_OUTPUT_BYTES} and {MAX_OUTPUT_BYTES}"
        )));
    }
    Ok(())
}

fn reject_nul(label: &str, value: &str) -> Result<(), RunError> {
    if value.contains('\0') {
        return Err(RunError::validation(format!(
            "{label} must not contain NUL"
        )));
    }
    Ok(())
}

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, RunError> {
    let canonical = canonical_existing(path, label)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        RunError::from_io(
            "validate_request",
            format!("inspect {label} {}", canonical.display()),
            error,
        )
    })?;
    if !metadata.is_file() {
        return Err(RunError::validation(format!(
            "{label} must be a regular file: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn trusted_powershell_executable() -> Result<ResolvedPowerShell, RunError> {
    // The release runner is x86_64, so CSIDL_PROGRAM_FILES resolves the native
    // Program Files directory (the same location exposed as ProgramW6432).
    // Do not accept mutable ProgramFiles/ProgramW6432 environment values as
    // additional trust roots.
    let program_files = program_files_directory()?;
    let search_path = std::env::var_os("PATH");
    if let Some(powershell) = trusted_pwsh_executable_from(&program_files, search_path.as_deref())?
    {
        return Ok(powershell);
    }

    // Resolve the Windows directory only after every PowerShell 7 candidate is
    // absent or untrusted. A failure here must not mask an already usable pwsh.
    let system_directory = system_directory()?;
    trusted_windows_powershell_fallback(&system_directory)
}

#[cfg(test)]
fn trusted_powershell_executable_from(
    program_files: &Path,
    search_path: Option<&OsStr>,
    system_directory: &Path,
) -> Result<ResolvedPowerShell, RunError> {
    if let Some(powershell) = trusted_pwsh_executable_from(program_files, search_path)? {
        return Ok(powershell);
    }
    trusted_windows_powershell_fallback(system_directory)
}

fn trusted_pwsh_executable_from(
    program_files: &Path,
    search_path: Option<&OsStr>,
) -> Result<Option<ResolvedPowerShell>, RunError> {
    let windows_apps = program_files.join("WindowsApps");

    // PowerShell's MSI/winget installer uses this stable location, but it does
    // not add that directory to PATH in every host configuration. Probe it
    // directly before considering PATH entries.
    let standard_install = program_files.join("PowerShell").join("7").join("pwsh.exe");
    if let Some(powershell) = trusted_powershell_candidate(
        &standard_install,
        program_files,
        Some(&windows_apps),
        "trusted PowerShell 7",
    )? {
        return Ok(Some(ResolvedPowerShell {
            executable: powershell,
            summary: PowerShellSummary {
                engine: PowerShellEngine::Pwsh,
                version: "7",
                fallback: false,
            },
        }));
    }

    if let Some(search_path) = search_path {
        for directory in std::env::split_paths(search_path) {
            let path_candidate = directory.join("pwsh.exe");
            // PATH is caller-controlled and routinely contains unavailable or
            // user-owned directories. Reject unrelated layouts without touching
            // the filesystem; only plausible machine installs fail closed on
            // probe errors other than NotFound.
            if !has_supported_pwsh_layout(&path_candidate, program_files) {
                continue;
            }
            let Some(version_directory) = path_candidate
                .parent()
                .and_then(|parent| parent.file_name())
            else {
                continue;
            };
            // Windows canonicalization may preserve caller-supplied casing. Rebase
            // the validated suffix onto the canonical trust root so containment
            // remains case-sensitive for NTFS directories without rejecting a PATH
            // alias whose Program Files prefix uses different casing.
            let candidate = program_files
                .join("PowerShell")
                .join(version_directory)
                .join("pwsh.exe");
            if let Some(powershell) = trusted_powershell_candidate(
                &candidate,
                program_files,
                Some(&windows_apps),
                "trusted PowerShell 7",
            )? {
                if !has_supported_pwsh_layout(&powershell, program_files) {
                    continue;
                }
                return Ok(Some(ResolvedPowerShell {
                    executable: powershell,
                    summary: PowerShellSummary {
                        engine: PowerShellEngine::Pwsh,
                        version: "7",
                        fallback: false,
                    },
                }));
            }
        }
    }

    Ok(None)
}

fn trusted_windows_powershell_fallback(
    system_directory: &Path,
) -> Result<ResolvedPowerShell, RunError> {
    let candidate = system_directory
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if let Some(powershell) = trusted_powershell_candidate(
        &candidate,
        system_directory,
        None,
        "trusted Windows PowerShell 5.1",
    )? {
        return Ok(ResolvedPowerShell {
            executable: powershell,
            summary: PowerShellSummary {
                engine: PowerShellEngine::WindowsPowerShell,
                version: "5.1",
                fallback: true,
            },
        });
    }

    Err(RunError::at(
        "resolve_executable",
        "PowerShell 7 (pwsh.exe) was not found at Program Files\\PowerShell\\7 or in a Program Files\\PowerShell\\7-* directory on PATH, and Windows PowerShell 5.1 (powershell.exe) was not found beneath the system directory; WindowsApps aliases are not trusted execution candidates",
    ))
}

fn has_supported_pwsh_layout(powershell: &Path, program_files: &Path) -> bool {
    let powershell_components = powershell.components().collect::<Vec<_>>();
    if powershell_components
        .iter()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }

    let program_files_components = program_files.components().collect::<Vec<_>>();
    if powershell_components.len() != program_files_components.len() + 3
        || !powershell_components
            .iter()
            .zip(&program_files_components)
            .all(|(candidate, trusted)| path_components_equal(*candidate, *trusted))
    {
        return false;
    }

    let suffix = &powershell_components[program_files_components.len()..];
    let Some(product_directory) = normal_component_name(suffix[0]) else {
        return false;
    };
    let Some(version_directory) = normal_component_name(suffix[1]) else {
        return false;
    };
    let Some(executable_name) = normal_component_name(suffix[2]) else {
        return false;
    };

    let version_directory = version_directory.to_string_lossy();
    product_directory
        .to_string_lossy()
        .eq_ignore_ascii_case("PowerShell")
        && (version_directory == "7" || version_directory.starts_with("7-"))
        && executable_name
            .to_string_lossy()
            .eq_ignore_ascii_case("pwsh.exe")
}

fn normal_component_name<'a>(component: Component<'a>) -> Option<&'a OsStr> {
    match component {
        Component::Normal(name) => Some(name),
        _ => None,
    }
}

fn path_components_equal(left: Component<'_>, right: Component<'_>) -> bool {
    match (left, right) {
        (Component::Prefix(left), Component::Prefix(right)) => {
            path_prefixes_equal(left.kind(), right.kind())
        }
        (Component::RootDir, Component::RootDir) => true,
        (Component::Normal(left), Component::Normal(right)) => left
            .to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy()),
        _ => false,
    }
}

fn path_prefixes_equal(left: Prefix<'_>, right: Prefix<'_>) -> bool {
    match (left, right) {
        (
            Prefix::Disk(left) | Prefix::VerbatimDisk(left),
            Prefix::Disk(right) | Prefix::VerbatimDisk(right),
        ) => left.eq_ignore_ascii_case(&right),
        _ => false,
    }
}

fn trusted_powershell_candidate(
    candidate: &Path,
    trusted_root: &Path,
    excluded_root: Option<&Path>,
    label: &str,
) -> Result<Option<PathBuf>, RunError> {
    let metadata = match std::fs::symlink_metadata(candidate) {
        Ok(metadata) => metadata,
        Err(error) if candidate_error_allows_fallback(&error) => return Ok(None),
        Err(error) => {
            return Err(RunError::from_io(
                "resolve_executable",
                format!("inspect {label} candidate {}", candidate.display()),
                error,
            ));
        }
    };
    // Ignore workspace-planted executables, directories named pwsh.exe, and
    // WindowsApps aliases. The final canonical path must remain a regular,
    // non-reparse file inside its trusted machine directory.
    if !metadata.is_file() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Ok(None);
    }
    let powershell = match canonical_file(candidate, label) {
        Ok(powershell) => powershell,
        Err(error) if run_error_is_not_found(&error) => return Ok(None),
        Err(mut error) => {
            error.stage = "resolve_executable".to_owned();
            return Err(error);
        }
    };
    if path_is_within(&powershell, trusted_root)
        && excluded_root.is_none_or(|root| !path_is_within(&powershell, root))
    {
        return Ok(Some(powershell));
    }
    Ok(None)
}

fn candidate_error_allows_fallback(error: &std::io::Error) -> bool {
    error.kind() == std::io::ErrorKind::NotFound
}

fn run_error_is_not_found(error: &RunError) -> bool {
    error.windows_error_code.is_some_and(|code| {
        std::io::Error::from_raw_os_error(code as i32).kind() == std::io::ErrorKind::NotFound
    })
}

fn program_files_directory() -> Result<PathBuf, RunError> {
    let mut buffer = vec![0_u16; 260];
    let result = unsafe {
        SHGetFolderPathW(
            0,
            CSIDL_PROGRAM_FILES as i32,
            0,
            SHGFP_TYPE_CURRENT as u32,
            buffer.as_mut_ptr(),
        )
    };
    if result != 0 {
        return Err(RunError::at(
            "resolve_executable",
            format!("SHGetFolderPathW(CSIDL_PROGRAM_FILES) failed with HRESULT 0x{result:08X}"),
        ));
    }
    let length = buffer.iter().position(|unit| *unit == 0).ok_or_else(|| {
        RunError::at(
            "resolve_executable",
            "SHGetFolderPathW returned an unterminated Program Files path",
        )
    })?;
    buffer.truncate(length);
    let path = PathBuf::from(OsString::from_wide(&buffer));
    canonical_directory(&path, "Program Files").map_err(|mut error| {
        error.stage = "resolve_executable".to_owned();
        error
    })
}

fn system_directory() -> Result<PathBuf, RunError> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let length = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if length == 0 {
            return Err(RunError::from_io(
                "resolve_executable",
                "GetSystemDirectoryW failed",
                std::io::Error::last_os_error(),
            ));
        }
        let length = length as usize;
        if length < buffer.len() {
            buffer.truncate(length);
            break;
        }
        buffer.resize(length, 0);
    }

    let path = PathBuf::from(OsString::from_wide(&buffer));
    canonical_directory(&path, "system directory").map_err(|mut error| {
        error.stage = "resolve_executable".to_owned();
        error
    })
}

fn canonical_directory(path: &Path, label: &str) -> Result<PathBuf, RunError> {
    let canonical = canonical_existing(path, label)?;
    let metadata = std::fs::metadata(&canonical).map_err(|error| {
        RunError::from_io(
            "validate_request",
            format!("inspect {label} {}", canonical.display()),
            error,
        )
    })?;
    if !metadata.is_dir() {
        return Err(RunError::validation(format!(
            "{label} must be a directory: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn canonical_existing(path: &Path, label: &str) -> Result<PathBuf, RunError> {
    ensure_local_absolute_path(path, label)?;
    let requested_metadata = std::fs::symlink_metadata(path).map_err(|error| {
        RunError::from_io(
            "validate_request",
            format!("inspect requested {label} {}", path.display()),
            error,
        )
    })?;
    if requested_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(RunError::validation(format!(
            "{label} must not be a reparse point: {}",
            path.display()
        )));
    }
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        RunError::from_io(
            "validate_request",
            format!("canonicalize {label} {}", path.display()),
            error,
        )
    })?;
    ensure_local_absolute_path(&canonical, label)?;
    let metadata = std::fs::symlink_metadata(&canonical).map_err(|error| {
        RunError::from_io(
            "validate_request",
            format!("inspect canonical {label} {}", canonical.display()),
            error,
        )
    })?;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(RunError::validation(format!(
            "{label} must not resolve to a reparse point: {}",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn ensure_local_absolute_path(path: &Path, label: &str) -> Result<(), RunError> {
    let mut components = path.components();
    let local_disk = matches!(
        components.next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    ) && matches!(components.next(), Some(Component::RootDir));
    if !local_disk {
        return Err(RunError::validation(format!(
            "{label} must be an absolute path on a local drive: {}",
            path.display()
        )));
    }
    Ok(())
}

fn canonical_writable_roots(values: &[String]) -> Result<Vec<PathBuf>, RunError> {
    if values.is_empty() {
        return Err(RunError::validation(
            "writable_roots must contain at least one workspace root",
        ));
    }
    let mut roots = Vec::with_capacity(values.len());
    let mut seen = HashSet::with_capacity(values.len());
    for (index, value) in values.iter().enumerate() {
        let root = canonical_directory(Path::new(value), &format!("writable_roots[{index}]"))?;
        if is_drive_root(&root) {
            return Err(RunError::validation(format!(
                "writable_roots must not contain a drive root: {}",
                root.display()
            )));
        }
        let key = normalized_path_key(&root);
        if !seen.insert(key) {
            return Err(RunError::validation(format!(
                "writable_roots contains a duplicate path: {}",
                root.display()
            )));
        }
        roots.push(root);
    }
    for left in 0..roots.len() {
        for right in (left + 1)..roots.len() {
            if path_is_within(&roots[left], &roots[right])
                || path_is_within(&roots[right], &roots[left])
            {
                return Err(RunError::validation(format!(
                    "writable_roots must not overlap: {} and {}",
                    roots[left].display(),
                    roots[right].display()
                )));
            }
        }
    }
    Ok(roots)
}

fn materialize_cagent_directories(
    roots: &[PathBuf],
    parent: &process::ParentProcess,
) -> Result<(), RunError> {
    for root in roots {
        parent.ensure_alive()?;
        create_verified_child_directory(
            root,
            ".cagent",
            root,
            "materialize_workspace_guards",
            "workspace .cagent directory",
        )?;
    }
    Ok(())
}

fn validate_workspace_tree(
    root: &Path,
    reject_reparse_points: bool,
    workspace_sid: &LocalSid,
    parent: &process::ParentProcess,
) -> Result<(), RunError> {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        parent.ensure_alive()?;
        let directory_metadata = std::fs::symlink_metadata(&directory).map_err(|error| {
            RunError::from_io(
                "validate_workspace_tree",
                format!("inspect directory {}", directory.display()),
                error,
            )
        })?;
        if directory_metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            if reject_reparse_points {
                return Err(RunError::at(
                    "validate_workspace_tree",
                    format!(
                        "refusing initial ACL propagation through a reparse-point directory: {}",
                        directory.display()
                    ),
                ));
            }
            continue;
        }
        if !directory_metadata.is_dir() {
            return Err(RunError::at(
                "validate_workspace_tree",
                format!(
                    "workspace directory changed type during validation: {}",
                    directory.display()
                ),
            ));
        }
        let canonical_directory = std::fs::canonicalize(&directory).map_err(|error| {
            RunError::from_io(
                "validate_workspace_tree",
                format!("canonicalize directory {}", directory.display()),
                error,
            )
        })?;
        if !path_is_within(&canonical_directory, root) {
            return Err(RunError::at(
                "validate_workspace_tree",
                format!(
                    "workspace traversal escaped its canonical root: {} -> {}",
                    directory.display(),
                    canonical_directory.display()
                ),
            ));
        }
        let entries = std::fs::read_dir(&directory).map_err(|error| {
            RunError::from_io(
                "validate_workspace_tree",
                format!("enumerate {}", directory.display()),
                error,
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                RunError::from_io(
                    "validate_workspace_tree",
                    format!("enumerate {}", directory.display()),
                    error,
                )
            })?;
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path).map_err(|error| {
                RunError::from_io(
                    "validate_workspace_tree",
                    format!("inspect {}", path.display()),
                    error,
                )
            })?;
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                if reject_reparse_points {
                    return Err(RunError::at(
                        "validate_workspace_tree",
                        format!(
                            "refusing initial ACL propagation through a descendant reparse point: {}",
                            path.display()
                        ),
                    ));
                }
                continue;
            }
            if metadata.is_dir() {
                pending.push(path);
                continue;
            }
            if metadata.is_file() {
                let links = security::file_link_count(&path).map_err(|error| {
                    RunError::at(
                        "validate_workspace_tree",
                        format!(
                            "could not determine hardlink count for {}: {error}",
                            path.display()
                        ),
                    )
                })?;
                if links > 1 {
                    // A hardlink shares its security descriptor and file data with
                    // every alias, including aliases outside the workspace (Bun's
                    // package cache is a common example). Never propagate the
                    // workspace write capability onto that shared file. An explicit
                    // deny for this workspace's synthetic SID wins over the root's
                    // inherited allow ACE, while normal host-user access is unchanged.
                    // The linked file remains readable to sandboxed commands, and an
                    // unrelated hardlink no longer prevents the command from starting.
                    security::deny_write_access(
                        &path,
                        std::slice::from_ref(workspace_sid),
                    )
                    .map_err(|error| {
                        RunError::at(
                            "protect_workspace_hardlink",
                            format!(
                                "failed to make multi-link file read-only (links={links}) {}: {error}",
                                path.display()
                            ),
                        )
                    })?;
                }
            }
        }
    }
    Ok(())
}

fn is_drive_root(path: &Path) -> bool {
    let mut components = path.components();
    matches!(
        components.next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    ) && matches!(components.next(), Some(Component::RootDir))
        && components.next().is_none()
}

struct TemporaryProfile {
    workspace_root: PathBuf,
    root: PathBuf,
    app_data: PathBuf,
    local_app_data: PathBuf,
    temp: PathBuf,
}

impl TemporaryProfile {
    fn create(workspace_roots: &[PathBuf]) -> Result<Self, RunError> {
        let workspace_root = workspace_roots.first().cloned().ok_or_else(|| {
            RunError::at(
                "create_profile",
                "at least one writable root is required for the temporary profile",
            )
        })?;
        verify_directory_within(
            &workspace_root,
            &workspace_root,
            "create_profile",
            "first writable root",
        )?;
        let sandbox_container = create_verified_child_directory(
            &workspace_root,
            ".cagent-sandbox",
            &workspace_root,
            "create_profile",
            "sandbox profile container",
        )?;
        let profile_container = create_verified_child_directory(
            &sandbox_container,
            "profiles",
            &workspace_root,
            "create_profile",
            "sandbox profiles directory",
        )?;

        let timestamp = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let mut created = None;
        for _ in 0..PROFILE_CREATE_ATTEMPTS {
            verify_directory_within(
                &profile_container,
                &workspace_root,
                "create_profile",
                "sandbox profiles directory",
            )?;
            let counter = PROFILE_COUNTER.fetch_add(1, Ordering::Relaxed);
            let candidate = profile_container.join(format!(
                "cagent-sandbox-{}-{timestamp:032x}-{counter:016x}",
                std::process::id()
            ));
            match std::fs::create_dir(&candidate) {
                Ok(()) => {
                    created = Some(candidate);
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => {
                    return Err(RunError::from_io(
                        "create_profile",
                        format!(
                            "create temporary profile under {}",
                            profile_container.display()
                        ),
                        error,
                    ));
                }
            }
        }
        let candidate = created.ok_or_else(|| {
            RunError::at(
                "create_profile",
                format!(
                    "could not allocate a unique temporary profile under {}",
                    profile_container.display()
                ),
            )
        })?;

        let mut profile = Self {
            workspace_root,
            root: candidate,
            app_data: PathBuf::new(),
            local_app_data: PathBuf::new(),
            temp: PathBuf::new(),
        };
        profile.root =
            canonical_directory(&profile.root, "temporary profile").map_err(|mut error| {
                error.stage = "create_profile".to_owned();
                error
            })?;
        if !path_is_within(&profile.root, &profile_container)
            || profile.root == profile_container
            || !path_is_within(&profile.root, &profile.workspace_root)
        {
            return Err(RunError::at(
                "create_profile",
                format!(
                    "temporary profile escaped its workspace container: {}",
                    profile.root.display()
                ),
            ));
        }

        let app_data_root = create_verified_child_directory(
            &profile.root,
            "AppData",
            &profile.workspace_root,
            "create_profile",
            "profile AppData directory",
        )?;
        profile.app_data = create_verified_child_directory(
            &app_data_root,
            "Roaming",
            &profile.workspace_root,
            "create_profile",
            "profile roaming AppData directory",
        )?;
        profile.local_app_data = create_verified_child_directory(
            &app_data_root,
            "Local",
            &profile.workspace_root,
            "create_profile",
            "profile local AppData directory",
        )?;
        profile.temp = create_verified_child_directory(
            &profile.root,
            "Temp",
            &profile.workspace_root,
            "create_profile",
            "profile temporary directory",
        )?;
        Ok(profile)
    }

    fn root(&self) -> &Path {
        &self.root
    }

    fn apply_environment(
        &self,
        environment: &mut BTreeMap<String, String>,
    ) -> Result<(), RunError> {
        let profile = environment_path(&self.root)?;
        set_environment(environment, "USERPROFILE", profile.clone());
        set_environment(environment, "HOME", profile.clone());
        set_environment(environment, "APPDATA", environment_path(&self.app_data)?);
        set_environment(
            environment,
            "LOCALAPPDATA",
            environment_path(&self.local_app_data)?,
        );
        let temp = environment_path(&self.temp)?;
        set_environment(environment, "TEMP", temp.clone());
        set_environment(environment, "TMP", temp);

        let bytes = profile.as_bytes();
        if bytes.len() < 3 || bytes[1] != b':' || bytes[2] != b'\\' {
            return Err(RunError::at(
                "create_profile_environment",
                format!("profile is not a drive-qualified path: {profile}"),
            ));
        }
        set_environment(environment, "HOMEDRIVE", profile[..2].to_owned());
        set_environment(environment, "HOMEPATH", profile[2..].to_owned());
        Ok(())
    }
}

impl Drop for TemporaryProfile {
    fn drop(&mut self) {
        // The process tree has already been terminated before this guard drops.
        // std::fs::remove_dir_all does not follow directory symlinks; cleanup is
        // deliberately best effort because it must not change the run result.
        // The lexical target was canonicalized beneath the writable workspace,
        // so a failed cleanup can leave state only inside that workspace.
        let Some(profile_container) = self.root.parent() else {
            return;
        };
        let Some(sandbox_container) = profile_container.parent() else {
            return;
        };
        if !path_is_within(&self.root, &self.workspace_root)
            || self.root == self.workspace_root
            || !cleanup_directory_is_unchanged(&self.workspace_root, &self.workspace_root)
            || !cleanup_directory_is_unchanged(sandbox_container, &self.workspace_root)
            || !cleanup_directory_is_unchanged(profile_container, &self.workspace_root)
            || !cleanup_directory_is_unchanged(&self.root, &self.workspace_root)
            || !cleanup_tree_has_no_reparse_points(&self.root, &self.workspace_root)
        {
            return;
        }
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn cleanup_directory_is_unchanged(path: &Path, workspace_root: &Path) -> bool {
    let Ok(metadata) = std::fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_dir() || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return false;
    }
    let Ok(canonical) = std::fs::canonicalize(path) else {
        return false;
    };
    path_is_within(&canonical, workspace_root)
        && normalized_path_key(&canonical) == normalized_path_key(path)
}

fn cleanup_tree_has_no_reparse_points(root: &Path, workspace_root: &Path) -> bool {
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        if !cleanup_directory_is_unchanged(&directory, workspace_root) {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(&directory) else {
            return false;
        };
        for entry in entries {
            let Ok(entry) = entry else {
                return false;
            };
            let path = entry.path();
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                return false;
            };
            if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return false;
            }
            if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    true
}

fn create_verified_child_directory(
    parent: &Path,
    name: &str,
    containment_root: &Path,
    stage: &'static str,
    label: &str,
) -> Result<PathBuf, RunError> {
    let canonical_parent =
        verify_directory_within(parent, containment_root, stage, "parent directory")?;
    let requested = parent.join(name);
    match std::fs::symlink_metadata(&requested) {
        Ok(metadata) => validate_plain_directory(&requested, &metadata, stage, label)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match std::fs::create_dir(&requested) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => {
                    return Err(RunError::from_io(
                        stage,
                        format!("create {label} {}", requested.display()),
                        error,
                    ));
                }
            }
        }
        Err(error) => {
            return Err(RunError::from_io(
                stage,
                format!("inspect {label} {}", requested.display()),
                error,
            ));
        }
    }

    let metadata = std::fs::symlink_metadata(&requested).map_err(|error| {
        RunError::from_io(
            stage,
            format!("reinspect {label} {}", requested.display()),
            error,
        )
    })?;
    validate_plain_directory(&requested, &metadata, stage, label)?;
    let canonical = verify_directory_within(&requested, containment_root, stage, label)?;
    if canonical == canonical_parent || !path_is_within(&canonical, &canonical_parent) {
        return Err(RunError::at(
            stage,
            format!(
                "{label} escaped its verified parent: {} -> {} (parent {})",
                requested.display(),
                canonical.display(),
                canonical_parent.display()
            ),
        ));
    }
    Ok(canonical)
}

fn validate_plain_directory(
    path: &Path,
    metadata: &std::fs::Metadata,
    stage: &'static str,
    label: &str,
) -> Result<(), RunError> {
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(RunError::at(
            stage,
            format!("{label} must not be a reparse point: {}", path.display()),
        ));
    }
    if !metadata.is_dir() {
        return Err(RunError::at(
            stage,
            format!("{label} must be a directory: {}", path.display()),
        ));
    }
    Ok(())
}

fn verify_directory_within(
    path: &Path,
    containment_root: &Path,
    stage: &'static str,
    label: &str,
) -> Result<PathBuf, RunError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|error| {
        RunError::from_io(stage, format!("inspect {label} {}", path.display()), error)
    })?;
    validate_plain_directory(path, &metadata, stage, label)?;
    let canonical = std::fs::canonicalize(path).map_err(|error| {
        RunError::from_io(
            stage,
            format!("canonicalize {label} {}", path.display()),
            error,
        )
    })?;
    ensure_local_absolute_path(&canonical, label).map_err(|mut error| {
        error.stage = stage.to_owned();
        error
    })?;
    if !path_is_within(&canonical, containment_root) {
        return Err(RunError::at(
            stage,
            format!(
                "{label} escaped its containment root: {} -> {} (root {})",
                path.display(),
                canonical.display(),
                containment_root.display()
            ),
        ));
    }
    Ok(canonical)
}

fn environment_path(path: &Path) -> Result<String, RunError> {
    let value = path.to_string_lossy();
    let value = value.strip_prefix(r"\\?\").unwrap_or(&value);
    if value.starts_with(r"UNC\") || value.contains('\0') {
        return Err(RunError::at(
            "create_profile_environment",
            format!("unsupported profile path: {}", path.display()),
        ));
    }
    Ok(value.to_owned())
}

fn set_environment(environment: &mut BTreeMap<String, String>, name: &str, value: String) {
    let duplicate = environment
        .keys()
        .find(|existing| existing.eq_ignore_ascii_case(name))
        .cloned();
    if let Some(duplicate) = duplicate {
        environment.remove(&duplicate);
    }
    environment.insert(name.to_owned(), value);
}

fn protect_sensitive_workspace_paths(roots: &[PathBuf], sids: &[LocalSid]) -> Result<(), RunError> {
    if roots.len() != sids.len() {
        return Err(RunError::at(
            "protect_workspace_acl",
            "workspace roots and capability SIDs do not match",
        ));
    }
    let mut protected = Vec::new();
    let mut delete_protected = Vec::new();
    let mut seen = HashSet::new();
    for root in roots {
        collect_git_protected_paths(root, &mut protected, &mut delete_protected)?;
        for name in [".cagent", ".mcp.json", "AGENTS.md", "CLAUDE.md"] {
            collect_existing_protected_path(&root.join(name), &mut protected)?;
        }
        let entries = std::fs::read_dir(root).map_err(|error| {
            RunError::from_io(
                "protect_workspace_acl",
                format!("enumerate workspace root {}", root.display()),
                error,
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|error| {
                RunError::from_io(
                    "protect_workspace_acl",
                    format!("enumerate workspace root {}", root.display()),
                    error,
                )
            })?;
            let name = entry.file_name().to_string_lossy().to_lowercase();
            if name.starts_with(".env") {
                collect_existing_protected_path(&entry.path(), &mut protected)?;
            }
        }
    }

    for path in protected {
        if !seen.insert(normalized_path_key(&path)) {
            continue;
        }
        let sid = roots
            .iter()
            .zip(sids)
            .find_map(|(root, sid)| path_is_within(&path, root).then_some(sid))
            .ok_or_else(|| {
                RunError::at(
                    "protect_workspace_acl",
                    format!(
                        "protected path is outside all workspace roots: {}",
                        path.display()
                    ),
                )
            })?;
        security::deny_write_access(&path, std::slice::from_ref(sid)).map_err(|error| {
            RunError::at(
                "protect_workspace_acl",
                format!("failed to protect {}: {error}", path.display()),
            )
        })?;
    }
    for path in delete_protected {
        if !seen.insert(normalized_path_key(&path)) {
            continue;
        }
        let sid = roots
            .iter()
            .zip(sids)
            .find_map(|(root, sid)| path_is_within(&path, root).then_some(sid))
            .ok_or_else(|| {
                RunError::at(
                    "protect_workspace_acl",
                    format!(
                        "delete-protected path is outside all workspace roots: {}",
                        path.display()
                    ),
                )
            })?;
        security::deny_root_delete_access(&path, sid).map_err(|error| {
            RunError::at(
                "protect_workspace_acl",
                format!(
                    "failed to protect {} from rename/delete: {error}",
                    path.display()
                ),
            )
        })?;
    }
    Ok(())
}

fn collect_git_protected_paths(
    root: &Path,
    protected: &mut Vec<PathBuf>,
    delete_protected: &mut Vec<PathBuf>,
) -> Result<(), RunError> {
    let git = root.join(".git");
    let metadata = match std::fs::symlink_metadata(&git) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(RunError::from_io(
                "protect_workspace_acl",
                format!("inspect {}", git.display()),
                error,
            ));
        }
    };
    reject_protected_reparse(&git, &metadata)?;
    if metadata.is_file() {
        protected.push(git);
        return Ok(());
    }
    if !metadata.is_dir() {
        return Err(RunError::at(
            "protect_workspace_acl",
            format!(".git is neither a file nor a directory: {}", git.display()),
        ));
    }
    // Keep normal Git index/object/ref writes working. Only configuration and
    // executable hooks are immutable; the directory object itself cannot be
    // renamed away, while a worktree gitfile is fully protected above.
    delete_protected.push(git.clone());
    collect_existing_protected_path(&git.join("config"), protected)?;
    collect_existing_protected_path(&git.join("hooks"), protected)?;
    Ok(())
}

fn collect_existing_protected_path(
    path: &Path,
    protected: &mut Vec<PathBuf>,
) -> Result<(), RunError> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(RunError::from_io(
                "protect_workspace_acl",
                format!("inspect protected path {}", path.display()),
                error,
            ));
        }
    };
    reject_protected_reparse(path, &metadata)?;
    protected.push(path.to_owned());
    Ok(())
}

fn reject_protected_reparse(path: &Path, metadata: &std::fs::Metadata) -> Result<(), RunError> {
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(RunError::at(
            "protect_workspace_acl",
            format!(
                "protected path must not be a reparse point: {}",
                path.display()
            ),
        ));
    }
    Ok(())
}

fn protect_runner_binary(roots: &[PathBuf], sids: &[LocalSid]) -> Result<(), RunError> {
    if roots.len() != sids.len() {
        return Err(RunError::at(
            "protect_runner_acl",
            "workspace roots and capability SIDs do not match",
        ));
    }
    let executable = std::env::current_exe().map_err(|error| {
        RunError::from_io("protect_runner_acl", "locate the sandbox runner", error)
    })?;
    let executable = canonical_file(&executable, "sandbox runner executable")?;
    let Some(sid) = roots
        .iter()
        .zip(sids)
        .find_map(|(root, sid)| path_is_within(&executable, root).then_some(sid))
    else {
        return Ok(());
    };
    let relevant_sid = std::slice::from_ref(sid);
    let parent = executable.parent().ok_or_else(|| {
        RunError::at(
            "protect_runner_acl",
            format!(
                "sandbox runner has no parent directory: {}",
                executable.display()
            ),
        )
    })?;

    // Protect both the directory entry and the file. The directory deny contains
    // FILE_DELETE_CHILD, while write-root allow ACEs deliberately do not, so a
    // sandboxed command cannot replace the trusted runner through its parent.
    security::deny_write_access(parent, relevant_sid).map_err(|error| {
        RunError::at(
            "protect_runner_acl",
            format!(
                "failed to protect runner directory {}: {error}",
                parent.display()
            ),
        )
    })?;
    security::deny_write_access(&executable, relevant_sid).map_err(|error| {
        RunError::at(
            "protect_runner_acl",
            format!(
                "failed to protect runner executable {}: {error}",
                executable.display()
            ),
        )
    })?;
    Ok(())
}

fn path_is_within(path: &Path, root: &Path) -> bool {
    let path = normalized_path_key(path);
    let root = normalized_path_key(root);
    path == root
        || path
            .strip_prefix(&root)
            .is_some_and(|rest| rest.starts_with('\\'))
}

fn normalized_path_key(path: &Path) -> String {
    // All callers supply canonical roots or paths derived from them. Preserve
    // the filesystem-reported casing so case-sensitive NTFS directories do not
    // collapse distinct siblings into the same containment boundary.
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    static TEST_DIRECTORY_COUNTER: AtomicU64 = AtomicU64::new(0);

    struct TestDirectory {
        path: PathBuf,
    }

    impl TestDirectory {
        fn create() -> Self {
            let counter = TEST_DIRECTORY_COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cagent-powershell-resolution-test-{}-{counter}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("create test directory");
            Self { path }
        }
    }

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    fn create_test_executable(path: &Path) {
        std::fs::create_dir_all(path.parent().expect("test executable parent"))
            .expect("create test executable parent");
        std::fs::write(path, b"test executable").expect("create test executable");
    }

    fn canonical_test_directory(path: &Path) -> PathBuf {
        canonical_directory(path, "test Program Files").expect("canonicalize test directory")
    }

    fn create_test_system_directory(temporary: &TestDirectory) -> PathBuf {
        let system_directory = temporary.path.join("Windows").join("System32");
        std::fs::create_dir_all(&system_directory).expect("create test system directory");
        canonical_test_directory(&system_directory)
    }

    fn valid_parent_pid() -> u32 {
        let current = std::process::id();
        if current == u32::MAX {
            current - 1
        } else {
            current + 1
        }
    }

    fn valid_request() -> SandboxRequest {
        SandboxRequest {
            version: crate::protocol::PROTOCOL_VERSION,
            request_id: "request-1".to_owned(),
            parent_pid: valid_parent_pid(),
            execution_mode: ExecutionMode::WorkspaceWrite,
            args: Vec::new(),
            cwd: "C:/workspace".to_owned(),
            writable_roots: vec!["C:/workspace".to_owned()],
            env: std::collections::BTreeMap::new(),
            timeout_ms: MIN_TIMEOUT_MS,
            max_output_bytes: MIN_OUTPUT_BYTES,
        }
    }

    fn assert_validation_error(request: &SandboxRequest, expected_message: &str) {
        let error =
            validate_request_shape(request).expect_err("request validation must reject the input");
        assert_eq!(error.stage, "validate_request");
        assert!(error.windows_error_code.is_none());
        assert!(
            error.message.contains(expected_message),
            "unexpected validation message: {}",
            error.message
        );
    }

    #[test]
    fn valid_request_shape_is_accepted() {
        assert!(validate_request_shape(&valid_request()).is_ok());
    }

    #[test]
    fn standard_powershell_install_is_preferred_over_path_and_fallback() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let executable = program_files.join("PowerShell").join("7").join("pwsh.exe");
        create_test_executable(&executable);
        let path_directory = program_files.join("PowerShell").join("7-preview");
        create_test_executable(&path_directory.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        create_test_executable(
            &system_directory
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
        let search_path =
            std::env::join_paths([path_directory]).expect("construct test search path");

        let resolved = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect("standard PowerShell install should be trusted");

        assert_eq!(
            resolved.executable,
            canonical_file(&executable, "test PowerShell").expect("canonicalize test executable")
        );
        assert!(matches!(resolved.summary.engine, PowerShellEngine::Pwsh));
        assert_eq!(resolved.summary.version, "7");
        assert!(!resolved.summary.fallback);
    }

    #[test]
    fn trusted_powershell_can_still_be_found_on_path() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let install_directory = program_files.join("PowerShell").join("7-preview");
        let executable = install_directory.join("pwsh.exe");
        create_test_executable(&executable);
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        create_test_executable(
            &system_directory
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
        let search_path =
            std::env::join_paths([install_directory]).expect("construct test search path");

        let resolved = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect("trusted PATH PowerShell should be found");

        assert_eq!(
            resolved.executable,
            canonical_file(&executable, "test PowerShell").expect("canonicalize test executable")
        );
        assert!(matches!(resolved.summary.engine, PowerShellEngine::Pwsh));
        assert_eq!(resolved.summary.version, "7");
        assert!(!resolved.summary.fallback);
    }

    #[test]
    fn program_files_path_case_alias_is_rebased_to_the_trusted_root() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let install_directory = program_files.join("PowerShell").join("7-preview");
        create_test_executable(&install_directory.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        create_test_executable(
            &system_directory
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe"),
        );
        let path_alias = PathBuf::from(install_directory.to_string_lossy().to_uppercase());
        let search_path = std::env::join_paths([path_alias]).expect("construct test search path");

        let resolved = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect("trusted PATH casing alias should be found");

        assert!(path_is_within(&resolved.executable, &program_files));
        assert!(matches!(resolved.summary.engine, PowerShellEngine::Pwsh));
        assert!(!resolved.summary.fallback);
    }

    #[test]
    fn pwsh_path_layout_filter_is_strict_and_case_insensitive() {
        let program_files = Path::new(r"\\?\C:\Program Files");

        assert!(has_supported_pwsh_layout(
            Path::new(r"c:\PROGRAM FILES\powershell\7\PWSH.EXE"),
            program_files,
        ));
        assert!(has_supported_pwsh_layout(
            Path::new(r"C:\Program Files\PowerShell\7-PREVIEW\pwsh.exe"),
            program_files,
        ));
        assert!(!has_supported_pwsh_layout(
            Path::new(r"C:\Program Files\PowerShell\7-preview\..\7\pwsh.exe"),
            program_files,
        ));
        assert!(!has_supported_pwsh_layout(
            Path::new(r"C:\Program Files\PowerShell\7-preview\bin\pwsh.exe"),
            program_files,
        ));
    }

    #[test]
    fn unrelated_unprobeable_path_entry_does_not_block_windows_powershell_fallback() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        std::fs::create_dir_all(&program_files).expect("create test Program Files");
        let unprobeable_directory = program_files.join("unrelated\0directory");
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        let executable = system_directory
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        create_test_executable(&executable);
        let search_path = unprobeable_directory.into_os_string();

        let resolved = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect("unrelated PATH entry must be ignored before filesystem probing");

        assert_eq!(
            resolved.executable,
            canonical_file(&executable, "test Windows PowerShell")
                .expect("canonicalize test executable")
        );
        assert!(matches!(
            resolved.summary.engine,
            PowerShellEngine::WindowsPowerShell
        ));
    }

    #[test]
    fn wrong_major_pwsh_on_path_is_rejected() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let install_directory = program_files.join("PowerShell").join("6");
        create_test_executable(&install_directory.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        let search_path =
            std::env::join_paths([install_directory]).expect("construct test search path");

        let error = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect_err("non-7.x PowerShell on PATH must be rejected");

        assert_eq!(error.stage, "resolve_executable");
    }

    #[test]
    fn pwsh_outside_powershell_subtree_on_path_is_rejected() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let install_directory = program_files.join("Vendor").join("7");
        create_test_executable(&install_directory.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        let search_path =
            std::env::join_paths([install_directory]).expect("construct test search path");

        let error = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect_err("pwsh outside Program Files\\PowerShell must be rejected");

        assert_eq!(error.stage, "resolve_executable");
    }

    #[test]
    fn windows_powershell_is_used_only_after_pwsh_is_not_found() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        std::fs::create_dir_all(&program_files).expect("create test Program Files");
        let system_directory = create_test_system_directory(&temporary);
        let executable = system_directory
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        create_test_executable(&executable);
        let program_files = canonical_test_directory(&program_files);

        let resolved = trusted_powershell_executable_from(&program_files, None, &system_directory)
            .expect("Windows PowerShell fallback should be trusted");

        assert_eq!(
            resolved.executable,
            canonical_file(&executable, "test Windows PowerShell")
                .expect("canonicalize test executable")
        );
        assert!(matches!(
            resolved.summary.engine,
            PowerShellEngine::WindowsPowerShell
        ));
        assert_eq!(resolved.summary.version, "5.1");
        assert!(resolved.summary.fallback);
    }

    #[test]
    fn powershell_outside_program_files_is_rejected() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        std::fs::create_dir_all(&program_files).expect("create test Program Files");
        let outside_directory = temporary.path.join("workspace-bin");
        create_test_executable(&outside_directory.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        let search_path =
            std::env::join_paths([outside_directory]).expect("construct test search path");

        let error = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect_err("PowerShell outside Program Files must be rejected");

        assert_eq!(error.stage, "resolve_executable");
    }

    #[test]
    fn windows_apps_alias_and_non_file_candidates_allow_windows_powershell_fallback() {
        let temporary = TestDirectory::create();
        let program_files = temporary.path.join("Program Files");
        let standard_candidate = program_files.join("PowerShell").join("7").join("pwsh.exe");
        std::fs::create_dir_all(&standard_candidate)
            .expect("create directory named like the standard executable");
        let windows_apps = program_files.join("WindowsApps");
        create_test_executable(&windows_apps.join("pwsh.exe"));
        let program_files = canonical_test_directory(&program_files);
        let system_directory = create_test_system_directory(&temporary);
        let fallback_executable = system_directory
            .join("WindowsPowerShell")
            .join("v1.0")
            .join("powershell.exe");
        create_test_executable(&fallback_executable);
        let search_path = std::env::join_paths([windows_apps]).expect("construct test search path");

        let resolved = trusted_powershell_executable_from(
            &program_files,
            Some(search_path.as_os_str()),
            &system_directory,
        )
        .expect("WindowsApps and non-file candidates must be skipped before fallback");

        assert_eq!(
            resolved.executable,
            canonical_file(&fallback_executable, "test Windows PowerShell")
                .expect("canonicalize test executable")
        );
        assert!(matches!(
            resolved.summary.engine,
            PowerShellEngine::WindowsPowerShell
        ));
        assert_eq!(resolved.summary.version, "5.1");
        assert!(resolved.summary.fallback);
    }

    #[test]
    fn only_not_found_candidate_errors_allow_fallback() {
        let not_found = std::io::Error::from_raw_os_error(2);
        let access_denied = std::io::Error::from_raw_os_error(5);

        assert!(candidate_error_allows_fallback(&not_found));
        assert!(!candidate_error_allows_fallback(&access_denied));

        let error = RunError::from_io(
            "resolve_executable",
            "inspect test PowerShell candidate",
            access_denied,
        );
        assert_eq!(error.stage, "resolve_executable");
        assert_eq!(error.windows_error_code, Some(5));
        assert!(error.message.contains("inspect test PowerShell candidate"));
    }

    #[test]
    fn request_id_boundaries_and_character_set_are_enforced() {
        let mut request = valid_request();
        request.request_id = "a".repeat(MAX_REQUEST_ID_BYTES);
        assert!(validate_request_shape(&request).is_ok());

        request.request_id = "Az09-_.:".to_owned();
        assert!(validate_request_shape(&request).is_ok());

        for value in ["", "has space", "has/slash", "non-ascii-é"] {
            request.request_id = value.to_owned();
            assert_validation_error(&request, "request_id");
        }

        request.request_id = "a".repeat(MAX_REQUEST_ID_BYTES + 1);
        assert_validation_error(&request, "request_id");

        request.request_id = "has\0nul".to_owned();
        assert_validation_error(&request, "must not contain NUL");
    }

    #[test]
    fn parent_pid_must_not_be_zero_or_the_runner() {
        let mut request = valid_request();
        request.parent_pid = 0;
        assert_validation_error(&request, "parent_pid");

        request.parent_pid = std::process::id();
        assert_validation_error(&request, "parent_pid");
    }

    #[test]
    fn collection_limits_are_inclusive() {
        let mut request = valid_request();
        request.args = vec![String::new(); MAX_ARGUMENTS];
        assert!(validate_request_shape(&request).is_ok());
        request.args.push(String::new());
        assert_validation_error(&request, "args exceeds");

        let mut request = valid_request();
        request.writable_roots = vec!["C:/workspace".to_owned(); MAX_WRITABLE_ROOTS];
        assert!(validate_request_shape(&request).is_ok());
        request.writable_roots.push("C:/other".to_owned());
        assert_validation_error(&request, "writable_roots exceeds");

        let mut request = valid_request();
        request.env = (0..MAX_ENVIRONMENT_ENTRIES)
            .map(|index| (format!("KEY_{index}"), String::new()))
            .collect();
        assert!(validate_request_shape(&request).is_ok());
        request
            .env
            .insert("KEY_OVER_THE_LIMIT".to_owned(), String::new());
        assert_validation_error(&request, "env exceeds");
    }

    #[test]
    fn nul_is_rejected_in_all_request_string_locations() {
        let mut request = valid_request();
        request.cwd = "C:/work\0space".to_owned();
        assert_validation_error(&request, "cwd must not contain NUL");

        let mut request = valid_request();
        request.args.push("argument\0value".to_owned());
        assert_validation_error(&request, "args[0] must not contain NUL");

        let mut request = valid_request();
        request.writable_roots[0] = "C:/work\0space".to_owned();
        assert_validation_error(&request, "writable_roots[0] must not contain NUL");

        let mut request = valid_request();
        request
            .env
            .insert("BAD\0NAME".to_owned(), "value".to_owned());
        assert_validation_error(&request, "environment variable name must not contain NUL");

        let mut request = valid_request();
        request
            .env
            .insert("NAME".to_owned(), "bad\0value".to_owned());
        assert_validation_error(&request, "environment variable NAME must not contain NUL");
    }

    #[test]
    fn environment_names_are_validated_case_insensitively() {
        let mut request = valid_request();
        request.env.insert(String::new(), "value".to_owned());
        assert_validation_error(&request, "is invalid");

        let mut request = valid_request();
        request.env.insert("A=B".to_owned(), "value".to_owned());
        assert_validation_error(&request, "is invalid");

        let mut request = valid_request();
        request.env.insert("Path".to_owned(), "first".to_owned());
        request.env.insert("PATH".to_owned(), "second".to_owned());
        assert_validation_error(&request, "duplicated with different casing");
    }

    #[test]
    fn timeout_and_output_limits_are_inclusive() {
        for timeout_ms in [MIN_TIMEOUT_MS, MAX_TIMEOUT_MS] {
            let mut request = valid_request();
            request.timeout_ms = timeout_ms;
            assert!(validate_request_shape(&request).is_ok());
        }
        for timeout_ms in [MIN_TIMEOUT_MS - 1, MAX_TIMEOUT_MS + 1] {
            let mut request = valid_request();
            request.timeout_ms = timeout_ms;
            assert_validation_error(&request, "timeout_ms must be between");
        }

        for max_output_bytes in [MIN_OUTPUT_BYTES, MAX_OUTPUT_BYTES] {
            let mut request = valid_request();
            request.max_output_bytes = max_output_bytes;
            assert!(validate_request_shape(&request).is_ok());
        }
        for max_output_bytes in [MIN_OUTPUT_BYTES - 1, MAX_OUTPUT_BYTES + 1] {
            let mut request = valid_request();
            request.max_output_bytes = max_output_bytes;
            assert_validation_error(&request, "max_output_bytes must be between");
        }
    }
}
