//! Detached Codex app-server hosts.
//!
//! Each ARC-owned Codex profile runs one app-server that listens on a private
//! Unix domain socket instead of Core's stdio. Core keeps only an index record
//! and connects through a disposable `app-server proxy` child, so replacing Core
//! never ends native turns. The next Core adopts the recorded server.
use crate::*;
use std::time::{Duration, Instant};

const DIRECTORY: &str = "codex-app-server";
const READY_TIMEOUT: Duration = Duration::from_secs(20);
const STOP_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug)]
pub(crate) struct Host {
    pub profile: String,
    pub fingerprint: String,
    pub pid: u32,
    pub process_start: String,
    pub socket: PathBuf,
    pub started_at: String,
    pub inherited_nofile: Value,
    /// True when this Core connected to a server started by an earlier Core.
    pub adopted: bool,
    /// True when the Codex executable changed after the recorded server started.
    pub outdated: bool,
}

fn directory() -> PathBuf {
    root().join(DIRECTORY)
}

fn checked(profile: &str) -> Result<&str> {
    if profile.is_empty()
        || profile.len() > 64
        || !profile
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        return Err("INVALID_ARGUMENT: Codex profile".into());
    }
    Ok(profile)
}

pub(crate) fn socket(profile: &str) -> Result<PathBuf> {
    Ok(directory().join(format!("{}.sock", checked(profile)?)))
}

fn record_path(profile: &str) -> Result<PathBuf> {
    Ok(directory().join(format!("{}.json", checked(profile)?)))
}

fn binary_stamp(binary: &Path) -> Value {
    let Ok(meta) = std::fs::metadata(binary) else {
        return Value::Null;
    };
    let modified = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_nanos().to_string());
    json!({"path":binary,"len":meta.len(),"modified":modified})
}

/// A platform token for the process creation time. Together with the PID it
/// identifies the recorded server and protects against PID reuse.
pub(crate) fn process_start(pid: u32) -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        // Field 22 (starttime); fields after the parenthesized command start at 3.
        let rest = &stat[stat.rfind(')')? + 1..];
        rest.split_whitespace().nth(19).map(str::to_owned)
    }
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
        // SAFETY: the buffer is a zeroed proc_bsdinfo of the declared size.
        let written = unsafe {
            libc::proc_pidinfo(
                pid as libc::c_int,
                libc::PROC_PIDTBSDINFO,
                0,
                &mut info as *mut _ as *mut libc::c_void,
                size,
            )
        };
        (written == size).then(|| format!("{}.{}", info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, FILETIME},
            System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION},
        };
        // SAFETY: the handle is checked and closed; output pointers have correct sizes.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return None;
            }
            let mut created: FILETIME = std::mem::zeroed();
            let (mut exited, mut kernel, mut user) = (created, created, created);
            let ok = GetProcessTimes(handle, &mut created, &mut exited, &mut kernel, &mut user);
            CloseHandle(handle);
            (ok != 0).then(|| {
                (((created.dwHighDateTime as u64) << 32) | created.dwLowDateTime as u64).to_string()
            })
        }
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = pid;
        None
    }
}

/// The server is alive and still the process this record started.
fn owned(record: &Value) -> Option<u32> {
    let pid = record["pid"].as_u64().and_then(|p| u32::try_from(p).ok())?;
    let start = record["processStart"].as_str()?;
    (crate::coordination::lifecycle::alive(pid).ok()?
        && process_start(pid).as_deref() == Some(start))
    .then_some(pid)
}

fn host(record: &Value, pid: u32, adopted: bool, binary: &Path) -> Host {
    Host {
        profile: string(record, "profile").to_owned(),
        fingerprint: string(record, "fingerprint").to_owned(),
        pid,
        process_start: string(record, "processStart").to_owned(),
        socket: PathBuf::from(string(record, "socket")),
        started_at: string(record, "startedAt").to_owned(),
        inherited_nofile: record["inheritedNofile"].clone(),
        adopted,
        outdated: adopted && record["binary"] != binary_stamp(binary),
    }
}

/// Reuse the recorded server for this profile or start a detached one.
pub(crate) async fn attach(
    binary: &Path,
    profile: &str,
    fingerprint: &str,
    launches: &crate::launches::Launches,
) -> Result<Host> {
    let path = record_path(profile)?;
    if let Ok(record) = load(&path) {
        if let Some(pid) = owned(&record) {
            return launches.run(|| Ok(host(&record, pid, true, binary)));
        }
        // The recorded server exited or its PID now names another process.
        discard(profile)?;
    }
    spawn(binary, profile, fingerprint, launches).await
}

/// Whether a detached server is recorded and still running for this profile.
pub(crate) fn running(profile: &str) -> bool {
    record_path(profile)
        .ok()
        .and_then(|path| load(&path).ok())
        .and_then(|record| owned(&record))
        .is_some()
}

/// Profiles whose recorded detached server is still running.
pub(crate) fn running_profiles() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(directory()) else {
        return vec![];
    };
    entries
        .flatten()
        .filter_map(|e| {
            e.file_name()
                .to_str()?
                .strip_suffix(".json")
                .map(str::to_owned)
        })
        .filter(|profile| running(profile))
        .collect()
}

fn discard(profile: &str) -> Result<()> {
    for path in [record_path(profile)?, socket(profile)?] {
        if std::fs::symlink_metadata(&path).is_ok() {
            std::fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn server_command(binary: &Path, profile: &str, socket: &Path) -> Result<std::process::Command> {
    let isolated = (profile != "codex-home").then_some(profile);
    let mut words: Vec<std::ffi::OsString> = crate::rpc::profile_arguments(isolated)
        .into_iter()
        .map(Into::into)
        .collect();
    words.extend(["app-server", "-c", "thread_unload_delay_secs=0", "--listen"].map(Into::into));
    words.push(format!("unix://{}", socket.to_str().ok_or("Invalid socket path")?).into());
    let mut command = std::process::Command::new(binary);
    command.args(&words);
    crate::rpc::profile_environment(&mut command, isolated)?;
    Ok(command)
}

#[cfg(target_os = "linux")]
fn systemd_scope(profile: &str) -> Option<std::process::Command> {
    std::env::var_os("INVOCATION_ID")?;
    let binary = ["/usr/bin/systemd-run", "/bin/systemd-run"]
        .into_iter()
        .map(Path::new)
        .find(|p| p.is_file())?;
    let mut scope = std::process::Command::new(binary);
    let unit = format!("arc-codex-{profile}-{}", &id()[..8]);
    scope.args([
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--unit",
        &unit,
        "--",
    ]);
    Some(scope)
}

async fn reachable(binary: &Path, socket: &Path) -> Option<Option<u32>> {
    #[cfg(unix)]
    {
        let _ = binary;
        let stream = std::fs::canonicalize(socket)
            .and_then(std::os::unix::net::UnixStream::connect)
            .ok()?;
        #[cfg(target_os = "linux")]
        {
            use std::os::fd::AsRawFd;
            let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
            let mut size = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
            let ok = unsafe {
                libc::getsockopt(
                    stream.as_raw_fd(),
                    libc::SOL_SOCKET,
                    libc::SO_PEERCRED,
                    &mut credentials as *mut _ as *mut libc::c_void,
                    &mut size,
                )
            };
            return (ok == 0).then_some(Some(credentials.pid as u32));
        }
        #[cfg(not(target_os = "linux"))]
        {
            let _ = stream;
            Some(None)
        }
    }
    #[cfg(windows)]
    {
        use crate::owned_children::SpawnOwned;
        let mut child = command(binary)
            .args(["app-server", "proxy", "--sock"])
            .arg(socket)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn_owned()
            .ok()?;
        let io = tokio::io::join(child.stdout.take()?, child.stdin.take()?);
        let ready = tokio::time::timeout(
            Duration::from_secs(1),
            tokio_tungstenite::client_async("ws://localhost/", io),
        )
        .await;
        let connected = matches!(ready, Ok(Ok(_)));
        let _ = child.kill().await;
        connected.then_some(None)
    }
}

/// The launcher publishes its own identity before executing Codex. Core may
/// disappear at any point without leaving an unindexed execution process.
pub async fn run() -> Result<()> {
    use std::io::{BufRead, Write};
    let mut line = String::new();
    std::io::stdin()
        .lock()
        .read_line(&mut line)
        .map_err(|e| e.to_string())?;
    let spec: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
    let profile = string(&spec["record"], "profile");
    let mut record = spec["record"].clone();
    let pid = std::process::id();
    #[cfg(unix)]
    unsafe {
        // systemd-run may fork before exec; the indexed process must lead the group.
        if libc::getsid(0) != pid as i32 && libc::setsid() == -1 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    record["pid"] = json!(pid);
    record["processStart"] = json!(process_start(pid).ok_or("CODEX_HOST_IDENTITY_UNAVAILABLE")?);
    #[cfg(windows)]
    let _job = crate::task_host::Job::own_tree()?;
    let mut command = server_command(
        Path::new(string(&spec, "binary")),
        profile,
        Path::new(string(&record, "socket")),
    )?;
    command
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null());
    // The launcher already leads the detached session; exec keeps that identity.
    save(&record_path(profile)?, &record)?;
    std::io::stdout()
        .write_all(b"indexed\n")
        .map_err(|e| e.to_string())?;
    std::io::stdout().flush().map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let error = command.exec();
        let _ = discard(profile);
        Err(format!("CODEX_HOST_START_FAILED: {error}"))
    }
    #[cfg(windows)]
    {
        let status = command.status().map_err(|e| e.to_string())?;
        discard(profile)?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("CODEX_HOST_EXIT: {status}"))
        }
    }
}

fn launch(
    binary: &Path,
    profile: &str,
    fingerprint: &str,
    scoped: bool,
) -> Result<std::process::Child> {
    let executable = crate::task_host::executable()?;
    let log = std::fs::File::create(directory().join(format!("{profile}.log")))
        .map_err(|e| e.to_string())?;
    let mut launcher = if scoped {
        #[cfg(target_os = "linux")]
        {
            let mut c = systemd_scope(profile).ok_or("CODEX_HOST_SCOPE_UNAVAILABLE")?;
            c.arg(&executable);
            c
        }
        #[cfg(not(target_os = "linux"))]
        {
            std::process::Command::new(&executable)
        }
    } else {
        std::process::Command::new(&executable)
    };
    launcher
        .arg("codex-host")
        .env("ARC_STATE_DIR", root())
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            launcher.pre_exec(|| {
                if libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
    }
    let spec = json!({"binary":binary,"record":{
        "profile":profile,"fingerprint":fingerprint,"socket":socket(profile)?,
        "binary":binary_stamp(binary),"startedAt":now(),"inheritedNofile":crate::resources::before_spawn(),
        "creatorPid":std::process::id(),"creatorStart":process_start(std::process::id()),"executable":executable
    }});
    let result = indexed_spawn(&mut launcher, &spec);
    if let Err(error) = result {
        if let Ok(record) = load(&record_path(profile)?) {
            if let Some(pid) = owned(&record) {
                signal(pid, true);
            }
        }
        return Err(error);
    }
    result
}

/// A launch is not released through the shutdown barrier until its independent
/// owner has published an index. This acknowledgement is private startup IPC.
pub(crate) fn indexed_spawn(
    command: &mut std::process::Command,
    spec: &Value,
) -> Result<std::process::Child> {
    use std::io::{BufRead, Write};
    let mut child = detached_spawn(command)?;
    let result = (|| -> Result<()> {
        child
            .stdin
            .take()
            .ok_or("CODEX_HOST_STDIN")?
            .write_all(format!("{spec}\n").as_bytes())
            .map_err(|e| e.to_string())?;
        let stdout = child.stdout.take().ok_or("CODEX_HOST_STDOUT")?;
        let (send, receive) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut line = String::new();
            let result = std::io::BufReader::new(stdout)
                .read_line(&mut line)
                .map(|_| line);
            let _ = send.send(result);
        });
        let ack = receive
            .recv_timeout(Duration::from_secs(10))
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        if ack != "indexed\n" {
            return Err("CODEX_HOST_START_FAILED: launcher did not publish its index".into());
        }
        Ok(())
    })();
    if let Err(error) = result {
        signal(child.id(), true);
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    Ok(child)
}

async fn spawn(
    binary: &Path,
    profile: &str,
    fingerprint: &str,
    launches: &crate::launches::Launches,
) -> Result<Host> {
    std::fs::create_dir_all(directory()).map_err(|e| e.to_string())?;
    let socket = socket(profile)?;
    discard(profile)?;
    #[cfg(target_os = "linux")]
    let attempts: &[bool] = if systemd_scope(profile).is_some() {
        &[true, false]
    } else {
        &[false]
    };
    #[cfg(not(target_os = "linux"))]
    let attempts: &[bool] = &[false];
    let mut failure = String::new();
    for &scoped in attempts {
        let mut child = match launches.run(|| launch(binary, profile, fingerprint, scoped)) {
            Ok(child) => child,
            Err(error) => {
                if scoped {
                    crate::logs::record(
                        "WARN",
                        &format!("Codex scope unavailable; using direct detachment: {error}"),
                        None,
                    );
                }
                failure = error;
                continue;
            }
        };
        // Publication is complete before the first await and before shutdown can
        // enter the barrier. The launcher also publishes if Core was killed.
        std::thread::spawn(move || {
            let _ = child.wait();
        });
        let deadline = Instant::now() + READY_TIMEOUT;
        loop {
            launches.check()?;
            if reachable(binary, &socket).await.is_some() {
                let record = load(&record_path(profile)?)?;
                if let Some(pid) = owned(&record) {
                    return Ok(host(&record, pid, false, binary));
                }
            }
            if !running(profile) || Instant::now() >= deadline {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        stop(profile).await?;
        failure = "CODEX_HOST_START_FAILED: socket did not accept a connection".into();
    }
    Err(failure)
}

pub(crate) fn executables() -> Vec<PathBuf> {
    running_profiles()
        .iter()
        .filter_map(|profile| {
            let record = load(&record_path(profile).ok()?).ok()?;
            record["executable"].as_str().map(PathBuf::from)
        })
        .collect()
}

/// A cancelled startup cannot have dispatched a turn. Retain only connections
/// that Control explicitly classified as active or uncertain during shutdown.
pub(crate) async fn stop_unattached(retained: &[(u32, String)]) {
    for profile in running_profiles() {
        let Ok(record) = record_path(&profile).and_then(|p| load(&p)) else {
            continue;
        };
        if retained
            .iter()
            .any(|(pid, start)| record["pid"] == *pid && record["processStart"] == *start)
        {
            continue;
        }
        if record["creatorPid"] == std::process::id()
            && record["creatorStart"].as_str() == process_start(std::process::id()).as_deref()
        {
            let _ = stop(&profile).await;
        }
    }
}

pub(crate) fn detached_spawn(command: &mut std::process::Command) -> Result<std::process::Child> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(
            CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_BREAKAWAY_FROM_JOB,
        );
        if let Ok(child) = command.spawn() {
            return Ok(child);
        }
        // A job without JOB_OBJECT_LIMIT_BREAKAWAY_OK rejects breakaway.
        command.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }
    command
        .spawn()
        .map_err(|e| format!("CODEX_HOST_START_FAILED: {e}"))
}

pub(crate) fn signal(pid: u32, force: bool) {
    #[cfg(unix)]
    {
        let signal = if force { libc::SIGKILL } else { libc::SIGTERM };
        // The server leads its own session and process group.
        // SAFETY: plain signal delivery to a verified PID/group.
        unsafe {
            if libc::kill(-(pid as i32), signal) != 0 {
                libc::kill(pid as i32, signal);
            }
        }
    }
    #[cfg(windows)]
    {
        let _ = force;
        let _ = std::process::Command::new("taskkill.exe")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

/// Stop the recorded server for this profile, ending any native turns it runs.
pub(crate) async fn stop(profile: &str) -> Result<()> {
    if let Ok(record) = load(&record_path(profile)?) {
        if let Some(pid) = owned(&record) {
            signal(pid, false);
            let deadline = Instant::now() + STOP_GRACE;
            while crate::coordination::lifecycle::alive(pid).unwrap_or(false) {
                if Instant::now() >= deadline {
                    signal(pid, true);
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
    discard(profile)
}

/// Stop every recorded server. Used when ARC itself is removed.
pub(crate) async fn stop_all() -> Result<()> {
    let Ok(entries) = std::fs::read_dir(directory()) else {
        return Ok(());
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(profile) = name.strip_suffix(".json") {
            stop(profile).await?;
        }
    }
    Ok(())
}
