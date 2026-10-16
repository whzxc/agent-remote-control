//! Standalone Core lifecycle. Configuration uses the existing authenticated CLI.
use crate::*;
use std::{process::Stdio, time::Duration};

async fn current() -> Result<Option<Value>> {
    init_crypto();
    crate::runtime::owner(&crate::runtime::build_id(&crate::runtime::binary()?)?).await
}

pub async fn status() -> Result<Value> {
    match current().await? {
        Some(info) => Ok(
            json!({"running":true,"pid":info["pid"],"daemon":info["daemon"],"stateDirectory":root(),"version":info["version"]}),
        ),
        None => Ok(json!({"running":false,"stateDirectory":root()})),
    }
}

pub async fn start() -> Result<Value> {
    if let Some(info) = current().await? {
        if info["daemon"] != true {
            return Err("CORE_NOT_DAEMON: a leased Core is already running; close its clients and run arc-remote stop before start.".into());
        }
        return status().await;
    }
    private_dir(&root())?;
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(root().join("core.log"))
        .map_err(|e| e.to_string())?;
    let mut command = std::process::Command::new(crate::runtime::binary()?);
    command
        .arg("daemon")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // Detach from the launching terminal, including its SIGHUP on logout.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() == -1 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("Core start failed: {e}"))?;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(info) = current().await? {
            if info["daemon"] != true {
                return Err(
                    "CORE_NOT_DAEMON: another local entrypoint started a leased Core.".into(),
                );
            }
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            return status().await;
        }
        if let Some(exit) = child.try_wait().map_err(|e| e.to_string())? {
            return Err(format!(
                "Core exited ({exit}); inspect {}/core.log",
                root().display()
            ));
        }
        if tokio::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Core startup timed out; inspect {}/core.log",
                root().display()
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

pub async fn stop() -> Result<Value> {
    if current().await?.is_some() {
        let client = crate::runtime::Client::connect(crate::runtime::binary()?, "cli").await?;
        let result = client.shutdown().await;
        client.close().await;
        result?;
    }
    status().await
}

#[cfg(not(target_os = "linux"))]
pub fn systemd() -> Result<Value> {
    Err("SYSTEMD_UNSUPPORTED: systemd --user is available on Linux only.".into())
}

#[cfg(target_os = "linux")]
pub fn systemd() -> Result<Value> {
    // systemd expands specifiers even inside quotes; ExecStart also expands dollars.
    fn quote(value: &str, exec: bool) -> Result<String> {
        if value.chars().any(char::is_control) {
            return Err("Invalid control character in systemd path/environment".into());
        }
        let value = value
            .replace('\\', "\\\\")
            .replace('"', "\\\"")
            .replace('%', "%%");
        Ok(format!(
            "\"{}\"",
            if exec {
                value.replace('$', "$$")
            } else {
                value
            }
        ))
    }
    let config = dirs::config_dir().ok_or("XDG config directory unavailable")?;
    let path = config.join("systemd/user/arc-remote.service");
    let binary = crate::runtime::binary()?;
    let mut unit = format!("[Unit]\nDescription=ARC (headless)\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\nExecStart={} daemon\nRestart=on-failure\nRestartSec=5\nTimeoutStopSec=30\nKillMode=mixed\nUMask=0077\nEnvironment={}\n",
        quote(binary.to_str().ok_or("Invalid binary path")?, true)?,
        quote(&format!("CLC_STATE_DIR={}", root().display()), false)?);
    for key in [
        "PATH",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "CODEX_HOME",
        "NVM_DIR",
        "BUN_INSTALL",
        "VOLTA_HOME",
    ] {
        if let Ok(value) = std::env::var(key) {
            let value = if key == "PATH" {
                let mut seen = std::collections::HashSet::new();
                value
                    .split(':')
                    .filter(|entry| seen.insert(*entry))
                    .collect::<Vec<_>>()
                    .join(":")
            } else {
                value
            };
            unit.push_str(&format!(
                "Environment={}\n",
                quote(&format!("{key}={value}"), false)?
            ));
        }
    }
    let env = config.join("chatgpt-local-connector/environment");
    // EnvironmentFile takes a literal absolute path, not shell-style quotes.
    // Reject special characters instead of interpreting escapes, globs or specifiers.
    let env_path = env.to_str().ok_or("Invalid config path")?;
    if !env.is_absolute()
        || !env_path
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"/._-@+".contains(&b))
    {
        return Err("Invalid EnvironmentFile path: set XDG_CONFIG_HOME to an absolute path using only ASCII letters, digits, / . _ - @ + (no spaces or special characters).".into());
    }
    unit.push_str(&format!(
        "EnvironmentFile=-{env_path}\n\n[Install]\nWantedBy=default.target\n"
    ));
    save_bytes(&path, unit.as_bytes())?;
    Ok(
        json!({"unit":path,"environmentFile":env,"next":"systemctl --user daemon-reload && systemctl --user enable --now arc-remote.service","linger":"loginctl enable-linger USER"}),
    )
}
