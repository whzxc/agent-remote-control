use crate::*;
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventSendOptions, NSString};
use std::collections::HashMap;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Instance {
    pub pid: u32,
    pub start: String,
    pub profile: Option<PathBuf>,
    endpoint: Option<String>,
    launch_id: Option<String>,
}

impl Instance {
    pub fn identity(&self) -> Value {
        json!({"pid":self.pid,"start":self.start})
    }
    pub fn independent(&self) -> bool {
        if self.profile.as_deref() != Some(&independent_profile()) {
            return false;
        }
        crate::kernel::file_cache::load(&root().join("desktop-launch.json")).is_ok_and(|r| {
            self.launch_id
                .as_ref()
                .is_some_and(|id| r["launchId"] == *id)
                || r["legacyInstance"] == self.identity()
        })
    }
    pub fn running(&self) -> bool {
        crate::codex_host::process_start(self.pid).as_deref() == Some(&self.start)
    }
}

pub(super) fn adopt_legacy(instance: &Instance) -> Result<()> {
    if instance.running() && instance.launch_id.is_none() && !instance.independent() {
        save(
            &root().join("desktop-launch.json"),
            &json!({"legacyInstance":instance.identity()}),
        )?;
    }
    Ok(())
}

pub(crate) fn socket() -> Result<PathBuf> {
    let path =
        crate::accounts::codex::default_home()?.join("app-server-control/app-server-control.sock");
    let socket = path.canonicalize().map_err(|error| error.to_string())?;
    let metadata = socket.metadata().map_err(|error| error.to_string())?;
    if !metadata.file_type().is_socket() || metadata.uid() != unsafe { libc::geteuid() } {
        return Err("DESKTOP_DAEMON_SOCKET_OWNER_MISMATCH".into());
    }
    Ok(socket)
}

fn url(socket: &Path) -> String {
    format!("ws+unix://localhost{}:/rpc", socket.display())
}

// Read only the launch variables that identify an instance. sysctl keeps argument
// and environment boundaries intact when this user's home or profile contains spaces.
fn identity_environment(
    pid: u32,
) -> Option<(
    Option<PathBuf>,
    Option<PathBuf>,
    Option<String>,
    Option<String>,
)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size = 0;
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            std::ptr::null_mut(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
        || size < 4
        || size > 1024 * 1024
    {
        return None;
    }
    let mut bytes = vec![0_u8; size];
    if unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            3,
            bytes.as_mut_ptr().cast(),
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    } != 0
    {
        return None;
    }
    if !(4..=bytes.len()).contains(&size) {
        return None;
    }
    let argc = usize::try_from(i32::from_ne_bytes(bytes[..4].try_into().ok()?)).ok()?;
    let rest = &bytes[4..size];
    let exec_end = rest.iter().position(|&byte| byte == 0)?;
    let rest = &rest[exec_end..];
    let argv = rest.iter().position(|&byte| byte != 0)?;
    let mut home = None;
    let mut profile = None;
    let mut endpoint = None;
    let mut launch_id = None;
    for entry in rest[argv..]
        .split(|&byte| byte == 0)
        .skip(argc)
        .take_while(|entry| !entry.is_empty())
    {
        let Ok(entry) = std::str::from_utf8(entry) else {
            continue;
        };
        if let Some(value) = entry.strip_prefix("CODEX_HOME=") {
            home = Some(PathBuf::from(value));
        } else if let Some(value) = entry.strip_prefix("CODEX_ELECTRON_USER_DATA_PATH=") {
            profile = Some(PathBuf::from(value));
        } else if let Some(value) = entry.strip_prefix("CODEX_APP_SERVER_WS_URL=") {
            endpoint = Some(value.to_owned());
        } else if let Some(value) = entry.strip_prefix("ARC_DESKTOP_LAUNCH_ID=") {
            launch_id = Some(value.to_owned());
        }
    }
    Some((home, profile, endpoint, launch_id))
}

pub(super) struct ProcessRow {
    pub uid: u32,
    pub pid: u32,
    pub parent: u32,
    pub tty: Option<String>,
    pub executable: PathBuf,
}

pub(super) async fn process_rows() -> Result<Vec<ProcessRow>> {
    let processes = output("/bin/ps", &["-axww", "-o", "uid=,pid=,ppid=,tty=,comm="]).await?;
    Ok(processes
        .lines()
        .filter_map(|line| {
            let (uid, rest) = line.trim().split_once(char::is_whitespace)?;
            let (pid, rest) = rest.trim_start().split_once(char::is_whitespace)?;
            let (parent, rest) = rest.trim_start().split_once(char::is_whitespace)?;
            let (tty, executable) = rest.trim_start().split_once(char::is_whitespace)?;
            Some(ProcessRow {
                uid: uid.parse().ok()?,
                pid: pid.parse().ok()?,
                parent: parent.parse().ok()?,
                tty: (!tty.starts_with('?') && tty != "-").then(|| tty.to_owned()),
                executable: PathBuf::from(executable.trim_start()),
            })
        })
        .collect())
}

pub(crate) async fn instances() -> Result<Vec<Instance>> {
    instances_in(&process_rows().await?)
}

pub(super) fn instances_in(rows: &[ProcessRow]) -> Result<Vec<Instance>> {
    let Some(installation) = super::installation() else {
        return Ok(Vec::new());
    };
    let app = installation.app;
    let executable = app
        .join("Contents/MacOS")
        .join(app.file_stem().ok_or("Invalid Desktop bundle")?);
    let user_home = dirs::home_dir()
        .ok_or("CODEX_HOME_UNAVAILABLE")?
        .join(".codex");
    let expected = crate::accounts::codex::default_home()?;
    let expected = expected.canonicalize().unwrap_or(expected);
    let mut instances = Vec::new();
    let uid = unsafe { libc::geteuid() };
    for row in rows {
        let pid = row.pid;
        if row.uid != uid || row.executable != executable {
            continue;
        }
        let Some(start) = crate::codex_host::process_start(pid) else {
            continue;
        };
        let (home, profile, endpoint, launch_id) =
            identity_environment(pid).ok_or("DESKTOP_PROCESS_SCOPE_UNAVAILABLE")?;
        let home = home.unwrap_or_else(|| user_home.clone());
        if home.canonicalize().unwrap_or(home) == expected {
            instances.push(Instance {
                pid,
                start,
                profile,
                endpoint,
                launch_id,
            });
        }
    }
    Ok(instances)
}

pub(crate) fn independent_profile() -> PathBuf {
    root().join("codex-desktop")
}

pub(crate) async fn native_peer(socket: &Path) -> Result<u32> {
    use std::os::fd::AsRawFd;
    let connection = tokio::net::UnixStream::connect(socket)
        .await
        .map_err(|e| e.to_string())?;
    let mut pid = 0_i32;
    let mut size = std::mem::size_of_val(&pid) as libc::socklen_t;
    if unsafe {
        libc::getsockopt(
            connection.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut i32).cast(),
            &mut size,
        )
    } != 0
        || pid <= 0
    {
        return Err("DESKTOP_DAEMON_IDENTITY_UNAVAILABLE".into());
    }
    Ok(pid as u32)
}

/// Verify a connected Unix socket from the target process tree to the daemon.
/// A launch variable alone can also describe a Desktop that failed to connect.
pub(crate) async fn connected() -> Result<Option<Instance>> {
    connected_profile(None).await
}

pub(crate) async fn connected_profile(profile: Option<&Path>) -> Result<Option<Instance>> {
    let Ok(socket) = socket() else {
        return Ok(None);
    };
    let expected = url(&socket);
    let rows = process_rows().await?;
    let mut candidates: Vec<_> = instances_in(&rows)?
        .into_iter()
        .filter(|instance| {
            instance.endpoint.as_deref() == Some(&expected)
                && profile.is_none_or(|p| instance.profile.as_deref() == Some(p))
        })
        .collect();
    if candidates.is_empty() {
        return Ok(None);
    }
    candidates.sort_by_key(|instance| (instance.profile.is_some(), instance.pid));
    let Ok(daemon) = native_peer(&socket).await else {
        return Ok(None);
    };
    let uid = unsafe { libc::geteuid() };
    let parent: HashMap<_, _> = rows
        .into_iter()
        .filter(|row| row.uid == uid)
        .map(|row| (row.pid, row.parent))
        .collect();
    let owner = |mut pid| {
        for _ in 0..12 {
            if let Some(instance) = candidates.iter().find(|instance| instance.pid == pid) {
                return Some(instance);
            }
            pid = *parent.get(&pid)?;
        }
        None
    };
    let pids = parent
        .keys()
        .copied()
        .filter(|pid| owner(*pid).is_some())
        .chain([daemon])
        .map(|pid| pid.to_string())
        .collect::<Vec<_>>()
        .join(",");
    let mut lsof = command("/usr/sbin/lsof");
    lsof.kill_on_drop(true)
        .args(["-nP", "-U", "-a", "-p", &pids]);
    let Ok(report) = tokio::time::timeout(Duration::from_secs(2), lsof.output()).await else {
        return Ok(None);
    };
    // A process can exit between the process and descriptor snapshots. lsof
    // may then exit nonzero even when it reports other live sockets.
    let report = report.map_err(|error| format!("DESKTOP_SOCKET_OBSERVATION_FAILED: {error}"))?;
    let sockets = String::from_utf8_lossy(&report.stdout);
    let sockets: Vec<_> = sockets
        .lines()
        .filter_map(|line| {
            let fields: Vec<_> = line.split_whitespace().collect();
            (fields.get(4) == Some(&"unix"))
                .then(|| {
                    Some((
                        fields.get(1)?.parse::<u32>().ok()?,
                        *fields.get(5)?,
                        *fields.get(7)?,
                    ))
                })
                .flatten()
        })
        .collect();
    let server_fds: std::collections::HashSet<_> = sockets
        .iter()
        .filter(|(pid, _, name)| *pid == daemon && *name == socket.to_string_lossy())
        .map(|(_, fd, _)| *fd)
        .collect();
    Ok(candidates
        .iter()
        .find(|instance| {
            instance.running()
                && sockets.iter().any(|(pid, _, name)| {
                    owner(*pid).is_some_and(|owner| owner.pid == instance.pid)
                        && name
                            .strip_prefix("->")
                            .is_some_and(|peer| server_fds.contains(peer))
                })
        })
        .cloned())
}

pub(crate) async fn start_daemon() -> Result<()> {
    match socket() {
        Ok(socket) if native_peer(&socket).await.is_ok() => return Ok(()),
        Err(error) if error == "DESKTOP_DAEMON_SOCKET_OWNER_MISMATCH" => return Err(error),
        _ => {}
    }
    let binary = super::require_installation()?.binary;
    run(
        &binary,
        &["app-server", "daemon", "start"],
        Duration::from_secs(12),
    )
    .await
}

async fn run(binary: &Path, args: &[&str], timeout: Duration) -> Result<()> {
    let mut child = command(binary);
    child
        .kill_on_drop(true)
        .args(args)
        .env("CODEX_HOME", crate::accounts::codex::default_home()?);
    let result = tokio::time::timeout(timeout, child.output())
        .await
        .map_err(|_| "DESKTOP_RECOVERY_TIMEOUT")?
        .map_err(|e| e.to_string())?;
    if result.status.success() {
        return Ok(());
    }
    Err(format!(
        "DESKTOP_RECOVERY_COMMAND_FAILED: {} exited {}",
        binary.file_name().unwrap_or_default().to_string_lossy(),
        result.status
    ))
}

pub(crate) async fn launch(profile: Option<&Path>) -> Result<()> {
    let app = super::require_installation()?.app;
    let home = crate::accounts::codex::default_home()?;
    let home_env = format!("CODEX_HOME={}", home.display());
    let url_env = format!("CODEX_APP_SERVER_WS_URL={}", url(&socket()?));
    let app = app.to_str().ok_or("Invalid Desktop bundle path")?;
    let mut args = vec!["-g", "--env", &home_env, "--env", &url_env];
    let profile_env;
    let profile_arg;
    let launch_env;
    if profile == Some(&independent_profile()) {
        let launch_id = id();
        save(
            &root().join("desktop-launch.json"),
            &json!({"launchId":launch_id}),
        )?;
        launch_env = format!("ARC_DESKTOP_LAUNCH_ID={launch_id}");
        args.extend(["--env", &launch_env]);
    }
    if let Some(profile) = profile {
        private_dir(profile)?;
        profile_env = format!("CODEX_ELECTRON_USER_DATA_PATH={}", profile.display());
        profile_arg = format!("--user-data-dir={}", profile.display());
        args.extend([
            "-n",
            "--env",
            &profile_env,
            "-a",
            app,
            "--args",
            &profile_arg,
        ]);
    } else {
        args.extend(["-a", app]);
    }
    run(Path::new("/usr/bin/open"), &args, Duration::from_secs(5)).await
}

async fn send_event(
    instance: Instance,
    class: [u8; 4],
    kind: [u8; 4],
    text: Option<String>,
) -> Result<()> {
    tokio::task::spawn_blocking(move || {
        if !instance.running() { return Err("DESKTOP_RECOVERY_TARGET_CHANGED".into()); }
        let target = NSAppleEventDescriptor::descriptorWithProcessIdentifier(instance.pid as i32);
        let event = NSAppleEventDescriptor::appleEventWithEventClass_eventID_targetDescriptor_returnID_transactionID(
            u32::from_be_bytes(class), u32::from_be_bytes(kind), Some(&target), -1, 0,
        );
        if let Some(text) = text {
            let value = NSAppleEventDescriptor::descriptorWithString(&NSString::from_str(&text));
            event.setParamDescriptor_forKeyword(&value, u32::from_be_bytes(*b"----"));
        }
        let reply = event.sendEventWithOptions_timeout_error(
            NSAppleEventSendOptions::WaitForReply | NSAppleEventSendOptions::NeverInteract, 4.0,
        ).map_err(|error| format!("DESKTOP_EVENT_FAILED: {error}"))?;
        let status = reply.paramDescriptorForKeyword(u32::from_be_bytes(*b"errn")).map_or(0, |status| status.int32Value());
        if status != 0 { return Err(format!("DESKTOP_EVENT_FAILED: Apple event error {status}")); }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}

pub(crate) async fn quit(instance: Instance) -> Result<()> {
    send_event(instance, *b"aevt", *b"quit", None).await
}

pub(crate) async fn open_thread(thread: &str, target: Option<&Value>) -> Result<()> {
    let profile = if let Some(target) = target {
        instances()
            .await?
            .into_iter()
            .find(|i| i.identity() == *target)
            .ok_or("DESKTOP_RECOVERY_TARGET_CHANGED")?
            .profile
    } else {
        None
    };
    let instance = connected_profile(profile.as_deref())
        .await?
        .ok_or("DESKTOP_DAEMON_APP_NOT_RUNNING")?;
    if target.is_some_and(|target| *target != instance.identity()) {
        return Err("DESKTOP_RECOVERY_TARGET_CHANGED".into());
    }
    reveal(instance, thread).await
}

pub(crate) async fn reveal(instance: Instance, thread: &str) -> Result<()> {
    send_event(
        instance,
        *b"GURL",
        *b"GURL",
        Some(format!("codex://threads/{thread}")),
    )
    .await
}
