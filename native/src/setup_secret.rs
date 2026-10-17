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
pub async fn read() -> Result<String> {
    #[cfg(feature = "test-fixture")]
    if root().join("fixtures/clipboard.txt").exists() {
        return std::fs::read_to_string(root().join("fixtures/clipboard.txt"))
            .map_err(|e| e.to_string());
    }
    let out = clipboard_command(false)
        .output()
        .await
        .map_err(|_| "Clipboard unavailable on this machine")?;
    if !out.status.success() {
        return Err("Cannot read clipboard".into());
    }
    String::from_utf8(out.stdout).map_err(|_| "Clipboard must contain text".into())
}
pub async fn clear() -> Result<()> {
    #[cfg(feature = "test-fixture")]
    if root().join("fixtures/clipboard.txt").exists() {
        return std::fs::write(root().join("fixtures/clipboard.txt"), "")
            .map_err(|e| e.to_string());
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
    Ok(())
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
    let (name, shape) = match field {
        "apiKey" => (
            "OpenAI runtime key",
            token.starts_with("sk-") && token.len() >= 32,
        ),
        "cloudflareToken" => (
            "Cloudflare Tunnel Token",
            token.starts_with("eyJ") && token.len() >= 64,
        ),
        "ngrokAuthtoken" => ("ngrok Authtoken", token.len() >= 20),
        "pinggyToken" => ("Pinggy Token", token.len() >= 16),
        "localxposeAccessToken" => ("LocalXpose Access Token", token.len() >= 20),
        _ => ("credential", false),
    };
    if !shape
        || token.len() > 4096
        || !token
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_./+=:-".contains(&c))
    {
        return Err(
            crate::i18n::text(&crate::i18n::locale(), "setup.clipboard-invalid")
                .replace("{credential}", name),
        );
    }
    Ok(token.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_each_credential_shape_without_echoing_bad_content() {
        let key = format!("sk-{}", "a".repeat(40));
        let token = format!("eyJ{}", "a".repeat(80));
        for (field, text, expected) in [
            ("apiKey", format!("OPENAI_API_KEY={key}"), key),
            (
                "cloudflareToken",
                format!("cloudflared service install {token}"),
                token,
            ),
            (
                "ngrokAuthtoken",
                format!("ngrok config add-authtoken {}", "a".repeat(24)),
                "a".repeat(24),
            ),
            (
                "pinggyToken",
                format!("ssh {}@a.pinggy.io", "a".repeat(20)),
                "a".repeat(20),
            ),
            (
                "localxposeAccessToken",
                format!("{{\"token\":\"{}\"}}", "a".repeat(24)),
                "a".repeat(24),
            ),
        ] {
            assert_eq!(extract(field, &text).unwrap(), expected);
            for bad in [
                "123456789",
                "sk-short",
                "eyJshort",
                "unrelated clipboard note",
            ] {
                let error = extract(field, bad).unwrap_err();
                assert!(!error.contains(bad));
            }
        }
        assert!(extract("apiKey", &"a".repeat(64)).is_err());
        assert!(extract("cloudflareToken", &"a".repeat(80)).is_err());
    }
}
