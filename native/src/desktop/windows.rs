use super::*;
use std::{
    os::windows::{ffi::OsStrExt, io::AsRawHandle, process::CommandExt},
    sync::OnceLock,
};
use windows_sys::Win32::{
    Foundation::{CloseHandle, HANDLE},
    Security::{EqualSid, GetTokenInformation, TokenUser, TOKEN_QUERY, TOKEN_USER},
    System::{
        Pipes::GetNamedPipeServerProcessId,
        Threading::{
            GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
        },
    },
    UI::Shell::ShellExecuteW,
};

pub(super) fn installation() -> Option<Installation> {
    static CACHE: OnceLock<std::sync::Mutex<Option<Installation>>> = OnceLock::new();
    let mut cache = CACHE.get_or_init(Default::default).lock().ok()?;
    if let Some(i) = cache
        .as_ref()
        .filter(|i| i.app.is_file() && i.binary.is_file())
    {
        return Some(i.clone());
    }
    let out = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty InstallLocation"])
        .creation_flags(0x08000000).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let location = String::from_utf8(out.stdout).ok()?;
    let app = PathBuf::from(location.trim()).join("app/ChatGPT.exe");
    if !app.is_file() {
        return None;
    }
    let resources = app.parent()?.join("resources");
    // Store executables cannot be launched by an unpackaged process. Keep the
    // bundled CLI and its sibling helpers together in a user-owned directory.
    let names = [
        "codex.exe",
        "codex-code-mode-host.exe",
        "codex-windows-sandbox-setup.exe",
        "codex-command-runner.exe",
    ];
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut digest = Sha256::new();
    for name in names {
        digest.update(name.as_bytes());
        let mut file = std::fs::File::open(resources.join(name)).ok()?;
        let mut bytes = [0; 65536];
        loop {
            let len = file.read(&mut bytes).ok()?;
            if len == 0 {
                break;
            }
            digest.update(&bytes[..len]);
        }
    }
    let directory = root()
        .join("bin/codex-desktop")
        .join(crate::hex_encode(&digest.finalize()));
    private_dir(&directory).ok()?;
    for name in names {
        let source = resources.join(name);
        let destination = directory.join(name);
        if std::fs::metadata(&destination).ok().map(|m| m.len())
            != Some(std::fs::metadata(&source).ok()?.len())
        {
            let temporary = directory.join(format!("{name}.tmp"));
            std::fs::copy(source, &temporary).ok()?;
            std::fs::rename(temporary, destination).ok()?;
        }
    }
    let installation = Installation {
        app,
        binary: directory.join("codex.exe"),
    };
    *cache = Some(installation.clone());
    Some(installation)
}

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
fn user_token(process: HANDLE) -> Result<Vec<usize>> {
    unsafe {
        let mut token = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return Err("DESKTOP_PIPE_OWNER_UNAVAILABLE".into());
        }
        let token = Handle(token);
        let mut size = 0;
        GetTokenInformation(token.0, TokenUser, std::ptr::null_mut(), 0, &mut size);
        let mut bytes = vec![0usize; (size as usize).div_ceil(std::mem::size_of::<usize>())];
        if GetTokenInformation(
            token.0,
            TokenUser,
            bytes.as_mut_ptr().cast(),
            size,
            &mut size,
        ) == 0
        {
            return Err("DESKTOP_PIPE_OWNER_UNAVAILABLE".into());
        }
        Ok(bytes)
    }
}
pub(super) async fn connect() -> Result<DesktopStream> {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    let pipe = loop {
        match tokio::net::windows::named_pipe::ClientOptions::new().open(r"\\.\pipe\codex-ipc") {
            Ok(pipe) => break pipe,
            Err(e) if e.raw_os_error() == Some(231) && tokio::time::Instant::now() < deadline => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    unsafe {
        let mut pid = 0;
        if GetNamedPipeServerProcessId(pipe.as_raw_handle() as HANDLE, &mut pid) == 0 {
            return Err("DESKTOP_PIPE_OWNER_UNAVAILABLE".into());
        }
        let process = Handle(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid));
        if process.0.is_null() {
            return Err("DESKTOP_PIPE_OWNER_UNAVAILABLE".into());
        }
        let owner = user_token(process.0)?;
        let current = user_token(GetCurrentProcess())?;
        let owner = &*(owner.as_ptr().cast::<TOKEN_USER>());
        let current = &*(current.as_ptr().cast::<TOKEN_USER>());
        if EqualSid(owner.User.Sid, current.User.Sid) == 0 {
            return Err("DESKTOP_PIPE_OWNER_MISMATCH".into());
        }
    }
    Ok(pipe)
}
pub(super) fn open(url: &str) -> Result<()> {
    let wide: Vec<u16> = std::ffi::OsStr::new(url)
        .encode_wide()
        .chain(Some(0))
        .collect();
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            std::ptr::null(),
            wide.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            1,
        )
    };
    if result as isize <= 32 {
        return Err(format!("DESKTOP_OPEN_FAILED:{}", result as isize));
    }
    Ok(())
}
