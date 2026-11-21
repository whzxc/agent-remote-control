use crate::*;
use objc2_foundation::{NSAppleEventDescriptor, NSAppleEventSendOptions, NSString};
use std::os::unix::fs::{FileTypeExt, MetadataExt};

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

/// LaunchServices preserves the configured URL for the lifetime of the app.
/// Match the installed executable and the exact native socket before dispatch.
pub(crate) async fn configured_pid() -> Option<i32> {
    let socket = socket().ok()?;
    let url = format!(
        "CODEX_APP_SERVER_WS_URL=ws+unix://localhost{}:/rpc",
        socket.display()
    );
    let app = super::installation()?.app;
    let name = app.file_stem()?;
    let executable = app.join("Contents/MacOS").join(name);
    let uid = unsafe { libc::geteuid() }.to_string();
    let processes = output("/bin/ps", &["-axww", "-o", "uid=,pid=,comm="])
        .await
        .ok()?;
    for line in processes.lines() {
        let Some((user, rest)) = line.trim().split_once(char::is_whitespace) else {
            continue;
        };
        let Some((pid, command)) = rest.trim_start().split_once(char::is_whitespace) else {
            continue;
        };
        if user != uid || Path::new(command.trim_start()) != executable {
            continue;
        }
        if let Ok(environment) = output("/bin/ps", &["eww", "-p", pid, "-o", "command="]).await {
            if environment
                .split_whitespace()
                .any(|variable| variable == url)
            {
                return pid.parse().ok();
            }
        }
    }
    None
}

pub(crate) async fn open_thread(thread: &str) -> Result<()> {
    let pid = configured_pid()
        .await
        .ok_or("DESKTOP_DAEMON_APP_NOT_RUNNING")?;
    let url = format!("codex://threads/{thread}");
    tokio::task::spawn_blocking(move || {
        // A bundle-wide open can send the URL to another instance of Desktop.
        let target = NSAppleEventDescriptor::descriptorWithProcessIdentifier(pid);
        let get_url = u32::from_be_bytes(*b"GURL");
        let event = NSAppleEventDescriptor::appleEventWithEventClass_eventID_targetDescriptor_returnID_transactionID(
            get_url, get_url, Some(&target), -1, 0,
        );
        let url = NSAppleEventDescriptor::descriptorWithString(&NSString::from_str(&url));
        event.setParamDescriptor_forKeyword(&url, u32::from_be_bytes(*b"----"));
        let reply = event.sendEventWithOptions_timeout_error(
            NSAppleEventSendOptions::WaitForReply | NSAppleEventSendOptions::NeverInteract,
            4.0,
        ).map_err(|error| format!("DESKTOP_DAEMON_OPEN_FAILED: {error}"))?;
        let status = reply.paramDescriptorForKeyword(u32::from_be_bytes(*b"errn"))
            .map_or(0, |status| status.int32Value());
        if status != 0 {
            return Err(format!("DESKTOP_DAEMON_OPEN_FAILED: Apple event error {status}"));
        }
        Ok(())
    }).await.map_err(|error| error.to_string())?
}
