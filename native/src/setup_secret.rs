//! Clipboard transfer is local to Core: no credential enters an RPC response or argv.
use crate::*;
use std::process::Stdio;
use tokio::io::AsyncWriteExt;

fn clipboard_command(write: bool) -> tokio::process::Command {
    #[cfg(target_os = "macos")]
    {
        command(if write {
            "/usr/bin/pbcopy"
        } else {
            "/usr/bin/pbpaste"
        })
    }
    #[cfg(windows)]
    {
        let mut cmd = command("powershell.exe");
        cmd.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            if write {
                "Set-Clipboard -Value ([Console]::In.ReadToEnd())"
            } else {
                "[Console]::OutputEncoding = [Text.UTF8Encoding]::new(); Get-Clipboard -Raw"
            },
        ]);
        cmd
    }
    #[cfg(target_os = "linux")]
    {
        let mut cmd = command(if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            if write {
                "wl-copy"
            } else {
                "wl-paste"
            }
        } else {
            "xclip"
        });
        if std::env::var_os("WAYLAND_DISPLAY").is_some() {
            if !write {
                cmd.arg("--no-newline");
            }
        } else {
            cmd.args([
                "-selection",
                "clipboard",
                if write { "-in" } else { "-out" },
            ]);
        }
        cmd
    }
}
pub async fn take() -> Result<String> {
    let out = clipboard_command(false)
        .output()
        .await
        .map_err(|_| "Clipboard unavailable on this machine")?;
    if !out.status.success() {
        return Err("Cannot read clipboard".into());
    }
    let mut clear = clipboard_command(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "Cannot clear clipboard")?;
    clear
        .stdin
        .take()
        .unwrap()
        .shutdown()
        .await
        .map_err(|_| "Cannot clear clipboard")?;
    if !clear
        .wait()
        .await
        .map_err(|_| "Cannot clear clipboard")?
        .success()
    {
        return Err("Cannot clear clipboard".into());
    }
    String::from_utf8(out.stdout).map_err(|_| "Clipboard must contain text".into())
}
pub fn extract(field: &str, text: &str) -> Result<String> {
    let text = text.trim();
    let mut candidate = text.to_owned();
    if let Ok(value) = serde_json::from_str::<Value>(text) {
        for key in [field, "token", "apiKey", "api_key", "authtoken"] {
            if let Some(value) = value[key].as_str() {
                candidate = value.to_owned();
                break;
            }
        }
    } else {
        let pattern = match field {
            "cloudflareToken" => {
                r#"(?:--token(?:=|\s+)|service\s+install\s+)["']?([A-Za-z0-9_./+=:-]+)"#
            }
            "ngrokAuthtoken" => {
                r#"(?:config\s+add-authtoken\s+|NGROK_AUTHTOKEN=)["']?([A-Za-z0-9_./+=:-]+)"#
            }
            "pinggyToken" => r#"(?:^|\s)["']?([A-Za-z0-9_./+=:-]+)@(?:[a-z0-9.-]+\.)?pinggy\.io"#,
            "localxposeAccessToken" => {
                r#"(?:--token(?:=|\s+)|LX_ACCESS_TOKEN=)["']?([A-Za-z0-9_./+=:-]+)"#
            }
            _ => r#"(?:OPENAI_API_KEY=|Authorization:\s*Bearer\s+)["']?([A-Za-z0-9_./+=:-]+)"#,
        };
        if let Some(found) = regex::Regex::new(pattern).unwrap().captures(text) {
            candidate = found[1].to_owned();
        }
    }
    let token = candidate.trim().trim_matches(['\'', '"']);
    if !(8..=4096).contains(&token.len())
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./+=:-".contains(&c))
    {
        return Err("Clipboard does not contain a recognized credential; copy the provider credential again or use the ARC form".into());
    }
    Ok(token.into())
}
