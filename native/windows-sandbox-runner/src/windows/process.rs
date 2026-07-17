use super::RunError;
use super::handle::OwnedHandle;
use super::security::inheritable_security_attributes;
use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::ffi::c_void;
use std::fs::File;
use std::io::Read;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::AsRawHandle;
use std::os::windows::io::FromRawHandle;
use std::path::Path;
use std::ptr;
use std::time::Duration;
use std::time::Instant;
use windows_sys::Win32::Foundation::ERROR_BROKEN_PIPE;
use windows_sys::Win32::Foundation::ERROR_NO_DATA;
use windows_sys::Win32::Foundation::ERROR_PIPE_NOT_CONNECTED;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HANDLE_FLAG_INHERIT;
use windows_sys::Win32::Foundation::SetHandleInformation;
use windows_sys::Win32::Foundation::WAIT_FAILED;
use windows_sys::Win32::Foundation::WAIT_OBJECT_0;
use windows_sys::Win32::Foundation::WAIT_TIMEOUT;
use windows_sys::Win32::System::JobObjects::CreateJobObjectW;
use windows_sys::Win32::System::JobObjects::IsProcessInJob;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_DESKTOP;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_DISPLAYSETTINGS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_EXITWINDOWS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_GLOBALATOMS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_HANDLES;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_READCLIPBOARD;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS;
use windows_sys::Win32::System::JobObjects::JOB_OBJECT_UILIMIT_WRITECLIPBOARD;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_BASIC_UI_RESTRICTIONS;
use windows_sys::Win32::System::JobObjects::JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
use windows_sys::Win32::System::JobObjects::JobObjectBasicUIRestrictions;
use windows_sys::Win32::System::JobObjects::JobObjectExtendedLimitInformation;
use windows_sys::Win32::System::JobObjects::SetInformationJobObject;
use windows_sys::Win32::System::JobObjects::TerminateJobObject;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Pipes::PeekNamedPipe;
use windows_sys::Win32::System::Threading::CREATE_NO_WINDOW;
use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;
use windows_sys::Win32::System::Threading::CREATE_UNICODE_ENVIRONMENT;
use windows_sys::Win32::System::Threading::CreateProcessAsUserW;
use windows_sys::Win32::System::Threading::DeleteProcThreadAttributeList;
use windows_sys::Win32::System::Threading::EXTENDED_STARTUPINFO_PRESENT;
use windows_sys::Win32::System::Threading::GetExitCodeProcess;
use windows_sys::Win32::System::Threading::INFINITE;
use windows_sys::Win32::System::Threading::InitializeProcThreadAttributeList;
use windows_sys::Win32::System::Threading::OpenProcess;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_HANDLE_LIST;
use windows_sys::Win32::System::Threading::PROC_THREAD_ATTRIBUTE_JOB_LIST;
use windows_sys::Win32::System::Threading::PROCESS_INFORMATION;
use windows_sys::Win32::System::Threading::ResumeThread;
use windows_sys::Win32::System::Threading::STARTF_USESTDHANDLES;
use windows_sys::Win32::System::Threading::STARTUPINFOEXW;
use windows_sys::Win32::System::Threading::TerminateProcess;
use windows_sys::Win32::System::Threading::UpdateProcThreadAttribute;
use windows_sys::Win32::System::Threading::WaitForSingleObject;

const MAX_COMMAND_LINE_UNITS: usize = 32_767;
const MAX_ENVIRONMENT_UNITS: usize = 32_767;
const PIPE_BUFFER_BYTES: u32 = 64 * 1024;
const DRAIN_BUFFER_BYTES: usize = 8 * 1024;
const MAX_DRAIN_PER_TICK: usize = 64 * 1024;
const WAIT_SLICE_MS: u32 = 20;
const TIMEOUT_EXIT_CODE: u32 = 124;
const PARENT_EXIT_CODE: u32 = 125;
const PROCESS_SYNCHRONIZE: u32 = 0x0010_0000;

pub struct ParentProcess {
    process: OwnedHandle,
    pid: u32,
}

impl ParentProcess {
    pub fn open(pid: u32) -> Result<Self, RunError> {
        let raw = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if raw == 0 {
            return Err(last_error(
                "open_parent_process",
                format!("OpenProcess(SYNCHRONIZE) failed for parent PID {pid}"),
            ));
        }
        let parent = Self {
            process: OwnedHandle::new(raw),
            pid,
        };
        parent.ensure_alive()?;
        Ok(parent)
    }

    pub fn ensure_alive(&self) -> Result<(), RunError> {
        if self.is_alive()? {
            return Ok(());
        }
        Err(RunError::at(
            "parent_process_exited",
            format!("parent PID {} has exited", self.pid),
        ))
    }

    fn is_alive(&self) -> Result<bool, RunError> {
        match unsafe { WaitForSingleObject(self.process.raw(), 0) } {
            WAIT_TIMEOUT => Ok(true),
            WAIT_OBJECT_0 => Ok(false),
            WAIT_FAILED => Err(last_error(
                "wait_parent_process",
                format!("WaitForSingleObject failed for parent PID {}", self.pid),
            )),
            result => Err(RunError {
                stage: "wait_parent_process".to_owned(),
                message: format!(
                    "WaitForSingleObject returned unexpected status {result} for parent PID {}",
                    self.pid
                ),
                windows_error_code: None,
            }),
        }
    }
}

pub struct ProcessSpec<'a> {
    pub parent: &'a ParentProcess,
    pub token: HANDLE,
    pub executable: &'a Path,
    pub args: &'a [String],
    pub cwd: &'a Path,
    pub env: &'a BTreeMap<String, String>,
    pub timeout_ms: u64,
    pub max_output_bytes: usize,
}

pub struct ProcessOutput {
    pub exit_code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    pub stdout_truncated: bool,
    pub stderr_truncated: bool,
}

pub fn run(spec: ProcessSpec<'_>) -> Result<ProcessOutput, RunError> {
    spec.parent.ensure_alive()?;
    let job = create_kill_on_close_job()?;
    let stdin_pipe = Pipe::new("create_stdin_pipe")?;
    let mut stdout_pipe = Pipe::new("create_stdout_pipe")?;
    let mut stderr_pipe = Pipe::new("create_stderr_pipe")?;

    set_not_inheritable(stdin_pipe.write.raw(), "configure_stdin_pipe")?;
    set_not_inheritable(stdout_pipe.read.raw(), "configure_stdout_pipe")?;
    set_not_inheritable(stderr_pipe.read.raw(), "configure_stderr_pipe")?;

    // The request protocol has no interactive stdin. Closing the only writer
    // before launch gives the child a deterministic EOF while still inheriting
    // the read end through the explicit handle list.
    drop(stdin_pipe.write);

    let mut inherited_handles = [
        stdin_pipe.read.raw(),
        stdout_pipe.write.raw(),
        stderr_pipe.write.raw(),
    ];
    let mut job_handles = [job.raw()];
    let attributes = ProcThreadAttributeList::with_handle_and_job_lists(
        &mut inherited_handles,
        &mut job_handles,
    )?;
    let mut startup: STARTUPINFOEXW = unsafe { std::mem::zeroed() };
    startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = inherited_handles[0];
    startup.StartupInfo.hStdOutput = inherited_handles[1];
    startup.StartupInfo.hStdError = inherited_handles[2];
    startup.lpAttributeList = attributes.as_ptr();

    let application = to_wide_nul(spec.executable.as_os_str());
    let mut command_line = build_command_line(spec.executable.as_os_str(), spec.args)?;
    let cwd = to_wide_nul(spec.cwd.as_os_str());
    let environment = build_environment(spec.env)?;
    let mut process_info: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    let creation_flags = CREATE_NO_WINDOW
        | CREATE_SUSPENDED
        | CREATE_UNICODE_ENVIRONMENT
        | EXTENDED_STARTUPINFO_PRESENT;
    let created = unsafe {
        CreateProcessAsUserW(
            spec.token,
            application.as_ptr(),
            command_line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            creation_flags,
            environment.as_ptr() as *const c_void,
            cwd.as_ptr(),
            &startup.StartupInfo,
            &mut process_info,
        )
    };
    if created == 0 {
        return Err(last_error(
            "create_process",
            format!(
                "CreateProcessAsUserW failed for {}",
                spec.executable.display()
            ),
        ));
    }
    if process_info.hProcess == 0 || process_info.hThread == 0 {
        let process = (process_info.hProcess != 0).then(|| OwnedHandle::new(process_info.hProcess));
        let thread = (process_info.hThread != 0).then(|| OwnedHandle::new(process_info.hThread));
        if process_info.hProcess != 0 {
            unsafe {
                TerminateProcess(process_info.hProcess, 1);
                WaitForSingleObject(process_info.hProcess, INFINITE);
            }
        }
        drop(thread);
        drop(process);
        return Err(RunError {
            stage: "create_process".to_owned(),
            message: "CreateProcessAsUserW returned invalid process handles".to_owned(),
            windows_error_code: None,
        });
    }

    let mut child = ChildProcess::new(process_info.hProcess, process_info.hThread);
    drop(attributes);
    drop(stdin_pipe.read);
    drop(stdout_pipe.write);
    drop(stderr_pipe.write);

    let mut is_job_member = 0;
    if unsafe { IsProcessInJob(child.process.raw(), job.raw(), &mut is_job_member) } == 0 {
        let error = last_error(
            "verify_job_membership",
            "IsProcessInJob failed after atomic job-list process creation",
        );
        terminate_job_best_effort(job.raw());
        return Err(error);
    }
    if is_job_member == 0 {
        terminate_job_best_effort(job.raw());
        return Err(RunError::at(
            "verify_job_membership",
            "CreateProcessAsUserW succeeded without placing the suspended process in the required job",
        ));
    }

    ensure_parent_alive_or_terminate(spec.parent, job.raw(), child.process.raw())?;

    if unsafe { ResumeThread(child.thread.raw()) } == u32::MAX {
        let resume_error = last_error("resume_process", "ResumeThread failed");
        terminate_job_best_effort(job.raw());
        return Err(resume_error);
    }

    let mut stdout_file = file_from_handle(&mut stdout_pipe.read);
    let mut stderr_file = file_from_handle(&mut stderr_pipe.read);
    let mut stdout = CaptureState::default();
    let mut stderr = CaptureState::default();
    let mut remaining_output_bytes = spec.max_output_bytes;
    let timeout = Duration::from_millis(spec.timeout_ms);
    let started = Instant::now();
    let timed_out;

    loop {
        ensure_parent_alive_or_terminate(spec.parent, job.raw(), child.process.raw())?;
        stdout.drain_available(
            &mut stdout_file,
            &mut remaining_output_bytes,
            "capture_stdout",
        )?;
        stderr.drain_available(
            &mut stderr_file,
            &mut remaining_output_bytes,
            "capture_stderr",
        )?;

        match unsafe { WaitForSingleObject(child.process.raw(), 0) } {
            WAIT_OBJECT_0 => {
                timed_out = false;
                break;
            }
            WAIT_TIMEOUT => {}
            WAIT_FAILED => {
                let error = last_error("wait_process", "WaitForSingleObject failed");
                terminate_job_best_effort(job.raw());
                return Err(error);
            }
            result => {
                terminate_job_best_effort(job.raw());
                return Err(RunError {
                    stage: "wait_process".to_owned(),
                    message: format!("WaitForSingleObject returned unexpected status {result}"),
                    windows_error_code: None,
                });
            }
        }

        let elapsed = started.elapsed();
        if elapsed >= timeout {
            timed_out = true;
            break;
        }
        let remaining_ms = (timeout - elapsed)
            .as_millis()
            .clamp(1, WAIT_SLICE_MS as u128) as u32;
        match unsafe { WaitForSingleObject(child.process.raw(), remaining_ms) } {
            WAIT_OBJECT_0 => {
                timed_out = false;
                break;
            }
            WAIT_TIMEOUT => {}
            WAIT_FAILED => {
                let error = last_error("wait_process", "WaitForSingleObject failed");
                terminate_job_best_effort(job.raw());
                return Err(error);
            }
            result => {
                terminate_job_best_effort(job.raw());
                return Err(RunError {
                    stage: "wait_process".to_owned(),
                    message: format!("WaitForSingleObject returned unexpected status {result}"),
                    windows_error_code: None,
                });
            }
        }
    }

    // Cover the race where the parent exits while the final bounded child wait
    // returns. A dead parent always wins over an otherwise successful result.
    ensure_parent_alive_or_terminate(spec.parent, job.raw(), child.process.raw())?;

    if timed_out {
        if unsafe { TerminateJobObject(job.raw(), TIMEOUT_EXIT_CODE) } == 0 {
            let error = last_error("terminate_job", "TerminateJobObject failed after timeout");
            // Closing a successfully configured kill-on-close job remains the
            // final cleanup boundary even when explicit termination reports an
            // error.
            drop(job);
            return Err(error);
        }
        wait_for_terminated_root(child.process.raw())?;
    }

    let mut exit_code = 0_u32;
    if unsafe { GetExitCodeProcess(child.process.raw(), &mut exit_code) } == 0 {
        let error = last_error("get_exit_code", "GetExitCodeProcess failed");
        terminate_job_best_effort(job.raw());
        return Err(error);
    }
    child.disarm();

    // The root process is done (or the whole job was explicitly terminated).
    // Closing the job now kills any surviving descendants before we perform
    // blocking reads to EOF, so descendants cannot keep the pipes open forever.
    drop(job);
    stdout.drain_to_eof(
        &mut stdout_file,
        &mut remaining_output_bytes,
        "capture_stdout",
    )?;
    stderr.drain_to_eof(
        &mut stderr_file,
        &mut remaining_output_bytes,
        "capture_stderr",
    )?;

    Ok(ProcessOutput {
        exit_code: exit_code as i32,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
        timed_out,
        stdout_truncated: stdout.truncated,
        stderr_truncated: stderr.truncated,
    })
}

fn create_kill_on_close_job() -> Result<OwnedHandle, RunError> {
    let raw = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if raw == 0 {
        return Err(last_error("create_job", "CreateJobObjectW failed"));
    }
    let job = OwnedHandle::new(raw);
    let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    let configured = unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectExtendedLimitInformation,
            &limits as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    };
    if configured == 0 {
        return Err(last_error(
            "configure_job",
            "SetInformationJobObject(KILL_ON_JOB_CLOSE) failed",
        ));
    }
    let ui_restrictions = JOBOBJECT_BASIC_UI_RESTRICTIONS {
        UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
            | JOB_OBJECT_UILIMIT_READCLIPBOARD
            | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
            | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
            | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
            | JOB_OBJECT_UILIMIT_GLOBALATOMS
            | JOB_OBJECT_UILIMIT_DESKTOP
            | JOB_OBJECT_UILIMIT_EXITWINDOWS,
    };
    let ui_configured = unsafe {
        SetInformationJobObject(
            job.raw(),
            JobObjectBasicUIRestrictions,
            &ui_restrictions as *const _ as *const c_void,
            std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
        )
    };
    if ui_configured == 0 {
        return Err(last_error(
            "configure_job_ui",
            "SetInformationJobObject(BasicUIRestrictions) failed",
        ));
    }
    Ok(job)
}

fn wait_for_terminated_root(process: HANDLE) -> Result<(), RunError> {
    match unsafe { WaitForSingleObject(process, INFINITE) } {
        WAIT_OBJECT_0 => Ok(()),
        WAIT_FAILED => Err(last_error(
            "wait_terminated_process",
            "WaitForSingleObject failed after terminating the job",
        )),
        result => Err(RunError {
            stage: "wait_terminated_process".to_owned(),
            message: format!("WaitForSingleObject returned unexpected status {result}"),
            windows_error_code: None,
        }),
    }
}

fn ensure_parent_alive_or_terminate(
    parent: &ParentProcess,
    job: HANDLE,
    root_process: HANDLE,
) -> Result<(), RunError> {
    match parent.is_alive() {
        Ok(true) => Ok(()),
        Ok(false) => {
            if unsafe { TerminateJobObject(job, PARENT_EXIT_CODE) } == 0 {
                return Err(last_error(
                    "terminate_job_parent_exit",
                    format!(
                        "parent PID {} exited and TerminateJobObject failed",
                        parent.pid
                    ),
                ));
            }
            wait_for_terminated_root(root_process)?;
            Err(RunError::at(
                "parent_process_exited",
                format!(
                    "parent PID {} exited; terminated all members of the sandbox job",
                    parent.pid
                ),
            ))
        }
        Err(error) => {
            terminate_job_best_effort(job);
            Err(error)
        }
    }
}

fn terminate_job_best_effort(job: HANDLE) {
    unsafe {
        TerminateJobObject(job, 1);
    }
}

struct ChildProcess {
    process: OwnedHandle,
    thread: OwnedHandle,
    armed: bool,
}

impl ChildProcess {
    fn new(process: HANDLE, thread: HANDLE) -> Self {
        Self {
            process: OwnedHandle::new(process),
            thread: OwnedHandle::new(thread),
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for ChildProcess {
    fn drop(&mut self) {
        if self.armed {
            // This is a last-resort guard for early returns. The process was
            // atomically created in the job, whose handle then removes descendants.
            unsafe {
                TerminateProcess(self.process.raw(), 1);
            }
        }
    }
}

struct Pipe {
    read: OwnedHandle,
    write: OwnedHandle,
}

impl Pipe {
    fn new(stage: &'static str) -> Result<Self, RunError> {
        let mut read = 0;
        let mut write = 0;
        let attributes = inheritable_security_attributes();
        if unsafe { CreatePipe(&mut read, &mut write, &attributes, PIPE_BUFFER_BYTES) } == 0 {
            return Err(last_error(stage, "CreatePipe failed"));
        }
        if read == 0 || write == 0 {
            if read != 0 {
                drop(OwnedHandle::new(read));
            }
            if write != 0 {
                drop(OwnedHandle::new(write));
            }
            return Err(RunError {
                stage: stage.to_owned(),
                message: "CreatePipe returned an invalid handle".to_owned(),
                windows_error_code: None,
            });
        }
        Ok(Self {
            read: OwnedHandle::new(read),
            write: OwnedHandle::new(write),
        })
    }
}

fn set_not_inheritable(handle: HANDLE, stage: &'static str) -> Result<(), RunError> {
    if unsafe { SetHandleInformation(handle, HANDLE_FLAG_INHERIT, 0) } == 0 {
        return Err(last_error(stage, "SetHandleInformation failed"));
    }
    Ok(())
}

struct ProcThreadAttributeList {
    _storage: Vec<usize>,
    pointer: *mut c_void,
}

impl ProcThreadAttributeList {
    fn with_handle_and_job_lists(
        handles: &mut [HANDLE],
        jobs: &mut [HANDLE],
    ) -> Result<Self, RunError> {
        let mut bytes = 0_usize;
        unsafe {
            InitializeProcThreadAttributeList(ptr::null_mut(), 2, 0, &mut bytes);
        }
        if bytes == 0 {
            return Err(last_error(
                "initialize_handle_list",
                "InitializeProcThreadAttributeList size query failed",
            ));
        }
        let words = bytes.div_ceil(std::mem::size_of::<usize>());
        let mut storage = vec![0_usize; words];
        let pointer = storage.as_mut_ptr() as *mut c_void;
        if unsafe { InitializeProcThreadAttributeList(pointer, 2, 0, &mut bytes) } == 0 {
            return Err(last_error(
                "initialize_handle_list",
                "InitializeProcThreadAttributeList failed",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                handles.as_ptr() as *const c_void,
                std::mem::size_of_val(handles),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            unsafe {
                DeleteProcThreadAttributeList(pointer);
            }
            return Err(last_error(
                "configure_handle_list",
                "UpdateProcThreadAttribute(HANDLE_LIST) failed",
            ));
        }
        if unsafe {
            UpdateProcThreadAttribute(
                pointer,
                0,
                PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
                jobs.as_ptr() as *const c_void,
                std::mem::size_of_val(jobs),
                ptr::null_mut(),
                ptr::null(),
            )
        } == 0
        {
            unsafe {
                DeleteProcThreadAttributeList(pointer);
            }
            return Err(last_error(
                "configure_job_list",
                "UpdateProcThreadAttribute(JOB_LIST) failed",
            ));
        }
        Ok(Self {
            _storage: storage,
            pointer,
        })
    }

    fn as_ptr(&self) -> *mut c_void {
        self.pointer
    }
}

impl Drop for ProcThreadAttributeList {
    fn drop(&mut self) {
        if !self.pointer.is_null() {
            unsafe {
                DeleteProcThreadAttributeList(self.pointer);
            }
        }
    }
}

#[derive(Default)]
struct CaptureState {
    bytes: Vec<u8>,
    truncated: bool,
    closed: bool,
}

impl CaptureState {
    fn drain_available(
        &mut self,
        file: &mut File,
        remaining: &mut usize,
        stage: &'static str,
    ) -> Result<(), RunError> {
        if self.closed {
            return Ok(());
        }
        let mut drained = 0_usize;
        while drained < MAX_DRAIN_PER_TICK {
            let available = match pipe_bytes_available(file) {
                Ok(value) => value as usize,
                Err(PipeState::Closed) => {
                    self.closed = true;
                    return Ok(());
                }
                Err(PipeState::Failed(error)) => return Err(error.with_stage(stage)),
            };
            if available == 0 {
                return Ok(());
            }
            let requested = available
                .min(DRAIN_BUFFER_BYTES)
                .min(MAX_DRAIN_PER_TICK - drained);
            let mut buffer = [0_u8; DRAIN_BUFFER_BYTES];
            match file.read(&mut buffer[..requested]) {
                Ok(0) => {
                    self.closed = true;
                    return Ok(());
                }
                Ok(read) => {
                    drained += read;
                    self.append(&buffer[..read], remaining);
                }
                Err(error) if is_closed_pipe_error(&error) => {
                    self.closed = true;
                    return Ok(());
                }
                Err(error) => {
                    return Err(RunError::from_io(stage, "read output pipe", error));
                }
            }
        }
        Ok(())
    }

    fn drain_to_eof(
        &mut self,
        file: &mut File,
        remaining: &mut usize,
        stage: &'static str,
    ) -> Result<(), RunError> {
        if self.closed {
            return Ok(());
        }
        let mut buffer = [0_u8; DRAIN_BUFFER_BYTES];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => {
                    self.closed = true;
                    return Ok(());
                }
                Ok(read) => self.append(&buffer[..read], remaining),
                Err(error) if is_closed_pipe_error(&error) => {
                    self.closed = true;
                    return Ok(());
                }
                Err(error) => {
                    return Err(RunError::from_io(stage, "read output pipe", error));
                }
            }
        }
    }

    fn append(&mut self, bytes: &[u8], remaining: &mut usize) {
        let keep = bytes.len().min(*remaining);
        self.bytes.extend_from_slice(&bytes[..keep]);
        *remaining -= keep;
        if keep != bytes.len() {
            self.truncated = true;
        }
    }
}

enum PipeState {
    Closed,
    Failed(DeferredPipeError),
}

struct DeferredPipeError {
    message: String,
    windows_error_code: Option<u32>,
}

impl DeferredPipeError {
    fn with_stage(self, stage: &'static str) -> RunError {
        RunError {
            stage: stage.to_owned(),
            message: self.message,
            windows_error_code: self.windows_error_code,
        }
    }
}

fn pipe_bytes_available(file: &File) -> Result<u32, PipeState> {
    let mut available = 0_u32;
    let ok = unsafe {
        PeekNamedPipe(
            file.as_raw_handle() as HANDLE,
            ptr::null_mut(),
            0,
            ptr::null_mut(),
            &mut available,
            ptr::null_mut(),
        )
    };
    if ok != 0 {
        return Ok(available);
    }
    let code = unsafe { GetLastError() };
    if matches!(
        code,
        ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED
    ) {
        Err(PipeState::Closed)
    } else {
        Err(PipeState::Failed(DeferredPipeError {
            message: format!("PeekNamedPipe failed with Windows error {code}"),
            windows_error_code: Some(code),
        }))
    }
}

fn is_closed_pipe_error(error: &std::io::Error) -> bool {
    error.raw_os_error().is_some_and(|code| {
        matches!(
            code as u32,
            ERROR_BROKEN_PIPE | ERROR_NO_DATA | ERROR_PIPE_NOT_CONNECTED
        )
    })
}

fn file_from_handle(handle: &mut OwnedHandle) -> File {
    unsafe { File::from_raw_handle(handle.take() as *mut c_void) }
}

fn build_command_line(executable: &OsStr, args: &[String]) -> Result<Vec<u16>, RunError> {
    let mut command_line = Vec::new();
    append_quoted_argument(&mut command_line, executable);
    for arg in args {
        command_line.push(b' ' as u16);
        append_quoted_argument(&mut command_line, OsStr::new(arg));
    }
    command_line.push(0);
    if command_line.len() > MAX_COMMAND_LINE_UNITS {
        return Err(RunError::validation(format!(
            "Windows command line exceeds {MAX_COMMAND_LINE_UNITS} UTF-16 code units"
        )));
    }
    Ok(command_line)
}

fn append_quoted_argument(destination: &mut Vec<u16>, argument: &OsStr) {
    let units: Vec<u16> = argument.encode_wide().collect();
    let requires_quotes = units.is_empty()
        || units
            .iter()
            .any(|unit| matches!(*unit, 0x09 | 0x0a | 0x0b | 0x20 | 0x22));
    if !requires_quotes {
        destination.extend(units);
        return;
    }

    destination.push(b'"' as u16);
    let mut backslashes = 0_usize;
    for unit in units {
        if unit == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if unit == b'"' as u16 {
            destination.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            destination.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        destination.push(unit);
    }
    destination.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    destination.push(b'"' as u16);
}

fn build_environment(env: &BTreeMap<String, String>) -> Result<Vec<u16>, RunError> {
    let mut entries: Vec<_> = env.iter().collect();
    entries.sort_by(|(left, _), (right, _)| {
        left.to_lowercase()
            .cmp(&right.to_lowercase())
            .then_with(|| left.cmp(right))
    });
    let mut block = Vec::new();
    for (name, value) in entries {
        block.extend(OsStr::new(name).encode_wide());
        block.push(b'=' as u16);
        block.extend(OsStr::new(value).encode_wide());
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    if block.len() > MAX_ENVIRONMENT_UNITS {
        return Err(RunError::validation(format!(
            "Windows environment block exceeds {MAX_ENVIRONMENT_UNITS} UTF-16 code units"
        )));
    }
    Ok(block)
}

fn to_wide_nul(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(std::iter::once(0)).collect()
}

fn last_error(stage: &'static str, message: impl Into<String>) -> RunError {
    let code = unsafe { GetLastError() };
    RunError {
        stage: stage.to_owned(),
        message: format!("{} (Windows error {code})", message.into()),
        windows_error_code: Some(code),
    }
}
