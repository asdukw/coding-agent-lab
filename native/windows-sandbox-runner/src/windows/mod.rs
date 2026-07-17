mod handle;
mod process;
mod security;

use crate::protocol::MAX_WRITABLE_ROOTS;
use crate::protocol::SandboxRequest;
use process::ProcessSpec;
use security::LocalSid;
use std::collections::BTreeMap;
use std::collections::HashSet;
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
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
use windows_sys::Win32::System::SystemInformation::GetSystemDirectoryW;

const MIN_TIMEOUT_MS: u64 = 100;
const MAX_TIMEOUT_MS: u64 = 10 * 60 * 1_000;
const MIN_OUTPUT_BYTES: usize = 1_024;
const MAX_OUTPUT_BYTES: usize = 1_024 * 1_024;
const MAX_ARGUMENTS: usize = 128;
const MAX_ENVIRONMENT_ENTRIES: usize = 4_096;
const MAX_REQUEST_ID_BYTES: usize = 128;
const PROFILE_CREATE_ATTEMPTS: u64 = 64;
const MAX_SYSTEM_DIRECTORY_UNITS: usize = 32_768;

static PROFILE_COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct RunResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
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
    let executable = trusted_powershell_executable()?;
    let cwd = canonical_directory(Path::new(&request.cwd), "cwd")?;
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
        validate_workspace_tree(root, !installed, &parent)?;
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
        token: token.raw(),
        executable: &executable,
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

fn trusted_powershell_executable() -> Result<PathBuf, RunError> {
    let mut buffer = vec![0_u16; 260];
    loop {
        let copied = unsafe { GetSystemDirectoryW(buffer.as_mut_ptr(), buffer.len() as u32) };
        if copied == 0 {
            let code = unsafe { GetLastError() };
            return Err(RunError {
                stage: "resolve_executable".to_owned(),
                message: format!("GetSystemDirectoryW failed with Windows error {code}"),
                windows_error_code: Some(code),
            });
        }
        let copied = copied as usize;
        if copied < buffer.len() {
            buffer.truncate(copied);
            let system_directory = PathBuf::from(OsString::from_wide(&buffer));
            let powershell = system_directory
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            return canonical_file(&powershell, "trusted Windows PowerShell").map_err(
                |mut error| {
                    error.stage = "resolve_executable".to_owned();
                    error
                },
            );
        }
        if copied > MAX_SYSTEM_DIRECTORY_UNITS {
            return Err(RunError::at(
                "resolve_executable",
                format!(
                    "GetSystemDirectoryW requested an unreasonable buffer of {copied} UTF-16 units"
                ),
            ));
        }
        buffer.resize(copied.saturating_add(1), 0);
    }
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
                    return Err(RunError::at(
                        "validate_workspace_tree",
                        format!(
                            "workspace contains a multi-link file (links={links}): {}",
                            path.display()
                        ),
                    ));
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
