use super::handle::OwnedHandle;
use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use sha2::Digest;
use sha2::Sha256;
use std::ffi::OsStr;
use std::ffi::c_void;
use std::path::Path;
use std::ptr;
use windows_sys::Win32::Foundation::ERROR_NOT_ALL_ASSIGNED;
use windows_sys::Win32::Foundation::ERROR_SUCCESS;
use windows_sys::Win32::Foundation::GetLastError;
use windows_sys::Win32::Foundation::HANDLE;
use windows_sys::Win32::Foundation::HLOCAL;
use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Foundation::SetLastError;
use windows_sys::Win32::Security::ACE_HEADER;
use windows_sys::Win32::Security::ACL;
use windows_sys::Win32::Security::ACL_SIZE_INFORMATION;
use windows_sys::Win32::Security::AclSizeInformation;
use windows_sys::Win32::Security::AdjustTokenPrivileges;
use windows_sys::Win32::Security::Authorization::DENY_ACCESS;
use windows_sys::Win32::Security::Authorization::EXPLICIT_ACCESS_W;
use windows_sys::Win32::Security::Authorization::GetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::SE_FILE_OBJECT;
use windows_sys::Win32::Security::Authorization::SET_ACCESS;
use windows_sys::Win32::Security::Authorization::SetEntriesInAclW;
use windows_sys::Win32::Security::Authorization::SetNamedSecurityInfoW;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_SID;
use windows_sys::Win32::Security::Authorization::TRUSTEE_IS_UNKNOWN;
use windows_sys::Win32::Security::Authorization::TRUSTEE_W;
use windows_sys::Win32::Security::CONTAINER_INHERIT_ACE;
use windows_sys::Win32::Security::CopySid;
use windows_sys::Win32::Security::CreateRestrictedToken;
use windows_sys::Win32::Security::DACL_SECURITY_INFORMATION;
use windows_sys::Win32::Security::EqualSid;
use windows_sys::Win32::Security::GetAce;
use windows_sys::Win32::Security::GetAclInformation;
use windows_sys::Win32::Security::GetLengthSid;
use windows_sys::Win32::Security::GetTokenInformation;
use windows_sys::Win32::Security::INHERIT_ONLY_ACE;
use windows_sys::Win32::Security::LookupPrivilegeValueW;
use windows_sys::Win32::Security::NO_PROPAGATE_INHERIT_ACE;
use windows_sys::Win32::Security::OBJECT_INHERIT_ACE;
use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;
use windows_sys::Win32::Security::SID_AND_ATTRIBUTES;
use windows_sys::Win32::Security::SetTokenInformation;
use windows_sys::Win32::Security::TOKEN_ADJUST_DEFAULT;
use windows_sys::Win32::Security::TOKEN_ADJUST_PRIVILEGES;
use windows_sys::Win32::Security::TOKEN_ADJUST_SESSIONID;
use windows_sys::Win32::Security::TOKEN_ASSIGN_PRIMARY;
use windows_sys::Win32::Security::TOKEN_DUPLICATE;
use windows_sys::Win32::Security::TOKEN_PRIVILEGES;
use windows_sys::Win32::Security::TOKEN_QUERY;
use windows_sys::Win32::Security::TokenDefaultDacl;
use windows_sys::Win32::Security::TokenGroups;
use windows_sys::Win32::Storage::FileSystem::BY_HANDLE_FILE_INFORMATION;
use windows_sys::Win32::Storage::FileSystem::CreateFileW;
use windows_sys::Win32::Storage::FileSystem::DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_DELETE_CHILD;
use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_EXECUTE;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_GENERIC_WRITE;
use windows_sys::Win32::Storage::FileSystem::FILE_READ_ATTRIBUTES;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_DELETE;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_WRITE;
use windows_sys::Win32::Storage::FileSystem::GetFileInformationByHandle;
use windows_sys::Win32::Storage::FileSystem::OPEN_EXISTING;
use windows_sys::Win32::System::Threading::GetCurrentProcess;

const DISABLE_MAX_PRIVILEGE: u32 = 0x01;
const LUA_TOKEN: u32 = 0x04;
const WRITE_RESTRICTED: u32 = 0x08;
const GENERIC_ALL: u32 = 0x1000_0000;
const SE_GROUP_LOGON_ID: u32 = 0xC000_0000;
const TOKEN_LINKED_TOKEN_CLASS: i32 = 19;
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0x00;
const ACCESS_DENIED_ACE_TYPE: u8 = 0x01;

#[repr(C)]
struct TokenDefaultDaclInfo {
    default_dacl: *mut ACL,
}

#[repr(C)]
struct TokenLinkedTokenInfo {
    linked_token: HANDLE,
}

#[repr(C)]
struct BasicAccessAce {
    header: ACE_HEADER,
    mask: u32,
    sid_start: u32,
}

pub struct LocalSid {
    ptr: *mut c_void,
}

impl LocalSid {
    pub fn from_string(value: &str) -> Result<Self> {
        let mut sid = ptr::null_mut();
        let wide = to_wide(OsStr::new(value));
        let ok = unsafe { ConvertStringSidToSidW(wide.as_ptr(), &mut sid) };
        if ok == 0 || sid.is_null() {
            return Err(anyhow!(
                "ConvertStringSidToSidW failed for {value}: {}",
                unsafe { GetLastError() }
            ));
        }
        Ok(Self { ptr: sid })
    }

    pub fn as_ptr(&self) -> *mut c_void {
        self.ptr
    }
}

impl Drop for LocalSid {
    fn drop(&mut self) {
        if !self.ptr.is_null() {
            unsafe {
                LocalFree(self.ptr as HLOCAL);
            }
        }
    }
}

pub fn capability_sid_for_root(root: &Path) -> String {
    // Callers pass canonical paths. Preserve the filesystem-reported casing:
    // case-sensitive NTFS directories may legally contain distinct Foo/foo
    // roots, and folding them would collapse two write capabilities into one.
    let normalized = root.to_string_lossy().replace('\\', "/");
    let mut hasher = Sha256::new();
    // This is a persistent ACL namespace, not the display name. Changing it
    // would orphan capability ACEs already installed in existing workspaces.
    hasher.update(b"coding-agent-learn/windows-sandbox/v1\0");
    hasher.update(normalized.as_bytes());
    let digest = hasher.finalize();
    let mut parts = [0_u32; 4];
    for (index, part) in parts.iter_mut().enumerate() {
        let start = index * 4;
        *part = u32::from_le_bytes(digest[start..start + 4].try_into().unwrap());
    }
    format!(
        "S-1-5-21-{}-{}-{}-{}",
        parts[0], parts[1], parts[2], parts[3]
    )
}

pub fn grant_write_access(path: &Path, sid: &LocalSid) -> Result<()> {
    set_path_ace(path, sid, SET_ACCESS, workspace_write_mask(), None)
}

pub fn write_access_is_present(path: &Path, sid: &LocalSid) -> Result<bool> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("inspect ACL target {}", path.display()))?;
    let inheritance = if metadata.is_dir() {
        CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
    } else {
        0
    };
    path_access_ace_covers(
        path,
        sid,
        workspace_write_mask(),
        inheritance,
        ACCESS_ALLOWED_ACE_TYPE,
    )
}

fn workspace_write_mask() -> u32 {
    FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE
}

pub fn file_link_count(path: &Path) -> Result<u32> {
    let wide = to_wide(path.as_os_str());
    let raw = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
            0,
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(anyhow!(
            "CreateFileW(FILE_READ_ATTRIBUTES) failed for {}: {}",
            path.display(),
            unsafe { GetLastError() }
        ));
    }
    let handle = OwnedHandle::new(raw);
    let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe { GetFileInformationByHandle(handle.raw(), &mut information) } == 0 {
        return Err(anyhow!(
            "GetFileInformationByHandle failed for {}: {}",
            path.display(),
            unsafe { GetLastError() }
        ));
    }
    Ok(information.nNumberOfLinks)
}

pub fn deny_write_access(path: &Path, sids: &[LocalSid]) -> Result<()> {
    for sid in sids {
        set_path_ace(
            path,
            sid,
            DENY_ACCESS,
            FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD,
            None,
        )?;
    }
    Ok(())
}

pub fn deny_root_delete_access(path: &Path, sid: &LocalSid) -> Result<()> {
    // This ACE applies to the root directory object only. In particular it must
    // not deny FILE_DELETE_CHILD or inherit, because descendants remain a normal
    // writable workspace.
    set_path_ace(path, sid, DENY_ACCESS, DELETE, Some(0))
}

fn set_path_ace(
    path: &Path,
    sid: &LocalSid,
    mode: i32,
    mask: u32,
    inheritance: Option<u32>,
) -> Result<()> {
    let metadata = std::fs::metadata(path)
        .with_context(|| format!("inspect ACL target {}", path.display()))?;
    let inheritance = inheritance.unwrap_or_else(|| {
        if metadata.is_dir() {
            CONTAINER_INHERIT_ACE | OBJECT_INHERIT_ACE
        } else {
            0
        }
    });
    let wide = to_wide(path.as_os_str());
    let mut security_descriptor: *mut c_void = ptr::null_mut();
    let mut current_acl: *mut ACL = ptr::null_mut();
    let get_result = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut current_acl,
            ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if get_result != ERROR_SUCCESS {
        return Err(anyhow!(
            "GetNamedSecurityInfoW failed for {}: {get_result}",
            path.display()
        ));
    }
    if current_acl.is_null() {
        if !security_descriptor.is_null() {
            unsafe {
                LocalFree(security_descriptor as HLOCAL);
            }
        }
        return Err(anyhow!(
            "refusing to replace the NULL DACL on {}",
            path.display()
        ));
    }

    let ace_type = if mode == DENY_ACCESS {
        Some(ACCESS_DENIED_ACE_TYPE)
    } else if mode == SET_ACCESS {
        Some(ACCESS_ALLOWED_ACE_TYPE)
    } else {
        None
    };
    if let Some(ace_type) = ace_type {
        let covered = existing_access_ace_covers(current_acl, sid, mask, inheritance, ace_type)
            .with_context(|| format!("inspect existing ACEs on {}", path.display()));
        match covered {
            Ok(true) => {
                unsafe {
                    LocalFree(security_descriptor as HLOCAL);
                }
                return Ok(());
            }
            Ok(false) => {}
            Err(error) => {
                unsafe {
                    LocalFree(security_descriptor as HLOCAL);
                }
                return Err(error);
            }
        }
    }

    let explicit = EXPLICIT_ACCESS_W {
        grfAccessPermissions: mask,
        grfAccessMode: mode,
        grfInheritance: inheritance,
        Trustee: TRUSTEE_W {
            pMultipleTrustee: ptr::null_mut(),
            MultipleTrusteeOperation: 0,
            TrusteeForm: TRUSTEE_IS_SID,
            TrusteeType: TRUSTEE_IS_UNKNOWN,
            ptstrName: sid.as_ptr() as *mut u16,
        },
    };
    let mut updated_acl: *mut ACL = ptr::null_mut();
    let acl_result = unsafe { SetEntriesInAclW(1, &explicit, current_acl, &mut updated_acl) };
    if acl_result != ERROR_SUCCESS {
        unsafe {
            LocalFree(security_descriptor as HLOCAL);
        }
        return Err(anyhow!(
            "SetEntriesInAclW failed for {}: {acl_result}",
            path.display()
        ));
    }

    let set_result = unsafe {
        SetNamedSecurityInfoW(
            wide.as_ptr() as *mut u16,
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            updated_acl,
            ptr::null_mut(),
        )
    };
    unsafe {
        if !updated_acl.is_null() {
            LocalFree(updated_acl as HLOCAL);
        }
        if !security_descriptor.is_null() {
            LocalFree(security_descriptor as HLOCAL);
        }
    }
    if set_result != ERROR_SUCCESS {
        return Err(anyhow!(
            "SetNamedSecurityInfoW failed for {}: {set_result}",
            path.display()
        ));
    }
    Ok(())
}

fn path_access_ace_covers(
    path: &Path,
    sid: &LocalSid,
    mask: u32,
    inheritance: u32,
    ace_type: u8,
) -> Result<bool> {
    let wide = to_wide(path.as_os_str());
    let mut security_descriptor: *mut c_void = ptr::null_mut();
    let mut current_acl: *mut ACL = ptr::null_mut();
    let get_result = unsafe {
        GetNamedSecurityInfoW(
            wide.as_ptr(),
            SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION,
            ptr::null_mut(),
            ptr::null_mut(),
            &mut current_acl,
            ptr::null_mut(),
            &mut security_descriptor,
        )
    };
    if get_result != ERROR_SUCCESS {
        return Err(anyhow!(
            "GetNamedSecurityInfoW failed for {}: {get_result}",
            path.display()
        ));
    }
    if current_acl.is_null() {
        if !security_descriptor.is_null() {
            unsafe {
                LocalFree(security_descriptor as HLOCAL);
            }
        }
        return Err(anyhow!(
            "refusing to inspect the NULL DACL on {}",
            path.display()
        ));
    }
    let result = existing_access_ace_covers(current_acl, sid, mask, inheritance, ace_type)
        .with_context(|| format!("inspect existing ACEs on {}", path.display()));
    unsafe {
        LocalFree(security_descriptor as HLOCAL);
    }
    result
}

fn existing_access_ace_covers(
    acl: *const ACL,
    sid: &LocalSid,
    mask: u32,
    inheritance: u32,
    ace_type: u8,
) -> Result<bool> {
    let mut information: ACL_SIZE_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        GetAclInformation(
            acl,
            &mut information as *mut _ as *mut c_void,
            std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
            AclSizeInformation,
        )
    } == 0
    {
        return Err(anyhow!("GetAclInformation failed: {}", unsafe {
            GetLastError()
        }));
    }

    for index in 0..information.AceCount {
        let mut raw_ace: *mut c_void = ptr::null_mut();
        if unsafe { GetAce(acl, index, &mut raw_ace) } == 0 || raw_ace.is_null() {
            return Err(anyhow!("GetAce({index}) failed: {}", unsafe {
                GetLastError()
            }));
        }
        let header = unsafe { &*(raw_ace as *const ACE_HEADER) };
        if header.AceType != ace_type
            || usize::from(header.AceSize) < std::mem::size_of::<BasicAccessAce>()
        {
            continue;
        }
        let ace = unsafe { &*(raw_ace as *const BasicAccessAce) };
        if ace.mask & mask != mask || !ace_inheritance_covers(header.AceFlags, inheritance) {
            continue;
        }
        let ace_sid = &ace.sid_start as *const u32 as *mut c_void;
        if unsafe { EqualSid(ace_sid, sid.as_ptr()) } != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

fn ace_inheritance_covers(existing_flags: u8, requested_inheritance: u32) -> bool {
    let existing_flags = u32::from(existing_flags);
    if existing_flags & INHERIT_ONLY_ACE != 0 {
        return false;
    }
    if requested_inheritance == 0 {
        return true;
    }
    if existing_flags & NO_PROPAGATE_INHERIT_ACE != 0 {
        return false;
    }
    existing_flags & requested_inheritance == requested_inheritance
}

pub fn create_restricted_token(
    capability_sids: &[LocalSid],
    profile_sid: &LocalSid,
) -> Result<OwnedHandle> {
    if capability_sids.is_empty() {
        return Err(anyhow!("at least one capability SID is required"));
    }
    let base = open_current_process_token()?;
    let mut logon_sid = get_logon_sid(base.raw())?;
    let everyone_sid = LocalSid::from_string("S-1-1-0")?;
    let logon_sid_ptr = logon_sid.as_mut_ptr() as *mut c_void;
    let everyone_sid_ptr = everyone_sid.as_ptr();
    let mut entries: Vec<SID_AND_ATTRIBUTES> = capability_sids
        .iter()
        .map(|sid| SID_AND_ATTRIBUTES {
            Sid: sid.as_ptr(),
            Attributes: 0,
        })
        .collect();
    // WRITE_RESTRICTED applies a second access check against this list. Keep
    // the logon session and Everyone SIDs so DLL initialization, PowerShell
    // pipelines, and desktop/system objects that use those well-known ACEs
    // remain usable; capability SIDs still gate filesystem writes.
    entries.push(SID_AND_ATTRIBUTES {
        Sid: logon_sid_ptr,
        Attributes: 0,
    });
    entries.push(SID_AND_ATTRIBUTES {
        Sid: everyone_sid_ptr,
        Attributes: 0,
    });
    let mut restricted_token: HANDLE = 0;
    let ok = unsafe {
        CreateRestrictedToken(
            base.raw(),
            DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED,
            0,
            ptr::null(),
            0,
            ptr::null(),
            entries.len() as u32,
            entries.as_mut_ptr(),
            &mut restricted_token,
        )
    };
    if ok == 0 {
        return Err(anyhow!("CreateRestrictedToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    let token = OwnedHandle::new(restricted_token);
    // Filesystem children inherit the appropriate stable workspace/profile SID
    // from their parent directory. The token default DACL must not stamp every
    // newly created object with all workspace SIDs: a failed profile cleanup
    // would then leave a workspace-capability-writable object outside workspace.
    // Logon and Everyone keep anonymous kernel objects (including PowerShell
    // pipes) usable, while only the request-scoped profile capability is added.
    let default_dacl_sids = vec![logon_sid_ptr, everyone_sid_ptr, profile_sid.as_ptr()];
    set_default_dacl(token.raw(), &default_dacl_sids)?;
    enable_change_notify(token.raw())?;
    Ok(token)
}

fn open_current_process_token() -> Result<OwnedHandle> {
    let desired = TOKEN_DUPLICATE
        | TOKEN_QUERY
        | TOKEN_ASSIGN_PRIMARY
        | TOKEN_ADJUST_DEFAULT
        | TOKEN_ADJUST_SESSIONID
        | TOKEN_ADJUST_PRIVILEGES;
    let mut token = 0;
    let ok = unsafe { OpenProcessToken(GetCurrentProcess(), desired, &mut token) };
    if ok == 0 {
        return Err(anyhow!("OpenProcessToken failed: {}", unsafe {
            GetLastError()
        }));
    }
    Ok(OwnedHandle::new(token))
}

fn get_logon_sid(token: HANDLE) -> Result<Vec<u8>> {
    if let Some(sid) = scan_token_groups_for_logon_sid(token)? {
        return Ok(sid);
    }

    let mut needed = 0_u32;
    unsafe {
        GetTokenInformation(
            token,
            TOKEN_LINKED_TOKEN_CLASS,
            ptr::null_mut(),
            0,
            &mut needed,
        );
    }
    if needed >= std::mem::size_of::<TokenLinkedTokenInfo>() as u32 {
        let mut buffer = vec![0_u8; needed as usize];
        let ok = unsafe {
            GetTokenInformation(
                token,
                TOKEN_LINKED_TOKEN_CLASS,
                buffer.as_mut_ptr() as *mut c_void,
                needed,
                &mut needed,
            )
        };
        if ok != 0 {
            let linked_info =
                unsafe { ptr::read_unaligned(buffer.as_ptr() as *const TokenLinkedTokenInfo) };
            if linked_info.linked_token != 0 {
                let linked_token = OwnedHandle::new(linked_info.linked_token);
                if let Some(sid) = scan_token_groups_for_logon_sid(linked_token.raw())? {
                    return Ok(sid);
                }
            }
        }
    }

    Err(anyhow!("logon SID is not present on the process token"))
}

fn scan_token_groups_for_logon_sid(token: HANDLE) -> Result<Option<Vec<u8>>> {
    let mut needed = 0_u32;
    unsafe {
        GetTokenInformation(token, TokenGroups, ptr::null_mut(), 0, &mut needed);
    }
    if needed == 0 {
        return Err(anyhow!("TokenGroups size query failed"));
    }
    let mut buffer = vec![0_u8; needed as usize];
    let ok = unsafe {
        GetTokenInformation(
            token,
            TokenGroups,
            buffer.as_mut_ptr() as *mut c_void,
            needed,
            &mut needed,
        )
    };
    if ok == 0 {
        return Err(anyhow!(
            "GetTokenInformation(TokenGroups) failed: {}",
            unsafe { GetLastError() }
        ));
    }

    let group_count = unsafe { ptr::read_unaligned(buffer.as_ptr() as *const u32) } as usize;
    let groups_start = unsafe { buffer.as_ptr().add(std::mem::size_of::<u32>()) } as usize;
    let alignment = std::mem::align_of::<SID_AND_ATTRIBUTES>();
    let aligned_start = (groups_start + alignment - 1) & !(alignment - 1);
    let groups_offset = aligned_start - buffer.as_ptr() as usize;
    let groups_size = group_count
        .checked_mul(std::mem::size_of::<SID_AND_ATTRIBUTES>())
        .ok_or_else(|| anyhow!("TokenGroups entry count overflow"))?;
    if groups_offset
        .checked_add(groups_size)
        .is_none_or(|end| end > buffer.len())
    {
        return Err(anyhow!("TokenGroups response is truncated"));
    }

    let groups = aligned_start as *const SID_AND_ATTRIBUTES;
    for index in 0..group_count {
        let entry = unsafe { ptr::read_unaligned(groups.add(index)) };
        if entry.Attributes & SE_GROUP_LOGON_ID != SE_GROUP_LOGON_ID {
            continue;
        }
        let sid_length = unsafe { GetLengthSid(entry.Sid) };
        if sid_length == 0 {
            return Err(anyhow!("GetLengthSid(logon SID) failed: {}", unsafe {
                GetLastError()
            }));
        }
        let mut sid = vec![0_u8; sid_length as usize];
        if unsafe { CopySid(sid_length, sid.as_mut_ptr() as *mut c_void, entry.Sid) } == 0 {
            return Err(anyhow!("CopySid(logon SID) failed: {}", unsafe {
                GetLastError()
            }));
        }
        return Ok(Some(sid));
    }
    Ok(None)
}

fn set_default_dacl(token: HANDLE, sids: &[*mut c_void]) -> Result<()> {
    let mut entries: Vec<EXPLICIT_ACCESS_W> = sids
        .iter()
        .map(|sid| EXPLICIT_ACCESS_W {
            grfAccessPermissions: GENERIC_ALL,
            grfAccessMode: SET_ACCESS,
            grfInheritance: 0,
            Trustee: TRUSTEE_W {
                pMultipleTrustee: ptr::null_mut(),
                MultipleTrusteeOperation: 0,
                TrusteeForm: TRUSTEE_IS_SID,
                TrusteeType: TRUSTEE_IS_UNKNOWN,
                ptstrName: *sid as *mut u16,
            },
        })
        .collect();
    let mut acl = ptr::null_mut();
    let result = unsafe {
        SetEntriesInAclW(
            entries.len() as u32,
            entries.as_mut_ptr(),
            ptr::null_mut(),
            &mut acl,
        )
    };
    if result != ERROR_SUCCESS {
        return Err(anyhow!(
            "SetEntriesInAclW(TokenDefaultDacl) failed: {result}"
        ));
    }
    let mut info = TokenDefaultDaclInfo { default_dacl: acl };
    let ok = unsafe {
        SetTokenInformation(
            token,
            TokenDefaultDacl,
            &mut info as *mut _ as *mut c_void,
            std::mem::size_of::<TokenDefaultDaclInfo>() as u32,
        )
    };
    if !acl.is_null() {
        unsafe {
            LocalFree(acl as HLOCAL);
        }
    }
    if ok == 0 {
        return Err(anyhow!(
            "SetTokenInformation(TokenDefaultDacl) failed: {}",
            unsafe { GetLastError() }
        ));
    }
    Ok(())
}

fn enable_change_notify(token: HANDLE) -> Result<()> {
    let mut luid = unsafe { std::mem::zeroed() };
    let name = to_wide(OsStr::new("SeChangeNotifyPrivilege"));
    if unsafe { LookupPrivilegeValueW(ptr::null(), name.as_ptr(), &mut luid) } == 0 {
        return Err(anyhow!("LookupPrivilegeValueW failed: {}", unsafe {
            GetLastError()
        }));
    }
    let mut privileges: TOKEN_PRIVILEGES = unsafe { std::mem::zeroed() };
    privileges.PrivilegeCount = 1;
    privileges.Privileges[0].Luid = luid;
    privileges.Privileges[0].Attributes = 0x0000_0002;
    unsafe {
        SetLastError(ERROR_SUCCESS);
    }
    let adjusted = unsafe {
        AdjustTokenPrivileges(token, 0, &privileges, 0, ptr::null_mut(), ptr::null_mut())
    };
    let error = unsafe { GetLastError() };
    if adjusted == 0 || error == ERROR_NOT_ALL_ASSIGNED {
        return Err(anyhow!("AdjustTokenPrivileges failed: {error}"));
    }
    Ok(())
}

pub fn inheritable_security_attributes() -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: ptr::null_mut(),
        bInheritHandle: 1,
    }
}

fn to_wide(value: &OsStr) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    value.encode_wide().chain(std::iter::once(0)).collect()
}

#[link(name = "advapi32")]
unsafe extern "system" {
    fn ConvertStringSidToSidW(value: *const u16, sid: *mut *mut c_void) -> i32;
    fn OpenProcessToken(process: HANDLE, desired_access: u32, token: *mut HANDLE) -> i32;
}

#[cfg(test)]
mod tests {
    use super::capability_sid_for_root;
    use std::path::Path;

    #[test]
    fn capability_sid_is_stable_and_path_scoped() {
        let first = capability_sid_for_root(Path::new(r"C:\workspace\one"));
        let same = capability_sid_for_root(Path::new(r"C:\workspace\one"));
        let case_distinct = capability_sid_for_root(Path::new(r"c:\WORKSPACE\one"));
        let other = capability_sid_for_root(Path::new(r"C:\workspace\two"));
        assert_eq!(first, same);
        assert_ne!(first, case_distinct);
        assert_ne!(first, other);
        assert!(first.starts_with("S-1-5-21-"));
    }
}
