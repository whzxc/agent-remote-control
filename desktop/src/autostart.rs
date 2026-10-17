//! OS login registration belongs to the Desktop executable.
#[cfg(target_os = "macos")]
use connector_core::{output, private_dir};
use connector_core::{root, Result};
pub async fn enabled() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    #[cfg(target_os = "macos")]
    {
        let Some(home) = dirs::home_dir() else {
            return false;
        };
        let path = home.join("Library/LaunchAgents/com.whzxc.agent-remote-control.plist");
        let path = path.to_string_lossy();
        let program = output(
            "plutil",
            &["-extract", "ProgramArguments.0", "raw", "-o", "-", &path],
        )
        .await;
        let state = output(
            "plutil",
            &[
                "-extract",
                "EnvironmentVariables.ARC_STATE_DIR",
                "raw",
                "-o",
                "-",
                &path,
            ],
        )
        .await;
        return program.is_ok_and(|s| s.trim() == exe.to_string_lossy())
            && state.is_ok_and(|s| s.trim() == root().to_string_lossy());
    }
    #[cfg(windows)]
    {
        return winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER)
            .open_subkey(RUN_KEY)
            .and_then(|key| key.get_value::<String, _>(RUN_VALUE))
            .is_ok_and(|value| value == login_command(&exe));
    }
    #[allow(unreachable_code)]
    false
}
#[cfg(windows)]
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(windows)]
const RUN_VALUE: &str = "Agent Remote Control";
#[cfg(windows)]
fn login_command(exe: &std::path::Path) -> String {
    let quote = |path: &std::path::Path| {
        let value = path.to_string_lossy();
        // Double trailing backslashes so they cannot escape the closing quote.
        let trailing = value.chars().rev().take_while(|c| *c == '\\').count();
        format!("\"{}{}\"", value, "\\".repeat(trailing))
    };
    format!("{} --autostart --state-dir {}", quote(exe), quote(&root()))
}
pub async fn set(enabled: bool) -> Result<()> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    {
        let path = dirs::home_dir()
            .unwrap()
            .join("Library/LaunchAgents/com.whzxc.agent-remote-control.plist");
        if enabled {
            let xml = |v: &str| {
                v.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
                    .replace('"', "&quot;")
            };
            private_dir(path.parent().unwrap())?;
            std::fs::write(path,format!("<?xml version=\"1.0\"?><plist version=\"1.0\"><dict><key>Label</key><string>com.whzxc.agent-remote-control</string><key>ProgramArguments</key><array><string>{}</string><string>--autostart</string></array><key>EnvironmentVariables</key><dict><key>ARC_STATE_DIR</key><string>{}</string></dict><key>RunAtLoad</key><true/></dict></plist>",xml(&exe.to_string_lossy()),xml(&root().to_string_lossy()))).map_err(|e|e.to_string())?;
        } else if path.exists() {
            std::fs::remove_file(path).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    #[cfg(windows)]
    {
        let user = winreg::RegKey::predef(winreg::enums::HKEY_CURRENT_USER);
        if enabled {
            let command = login_command(&exe);
            // Windows Run values support command lines up to 260 characters.
            if command.encode_utf16().count() > 260 {
                return Err("登录启动命令超过 Windows 的 260 字符限制".into());
            }
            let (key, _) = user.create_subkey(RUN_KEY).map_err(|e| e.to_string())?;
            key.set_value(RUN_VALUE, &command)
                .map_err(|e| e.to_string())?;
        } else {
            let result = user
                .open_subkey_with_flags(RUN_KEY, winreg::enums::KEY_SET_VALUE)
                .and_then(|key| key.delete_value(RUN_VALUE));
            if let Err(error) = result {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.to_string());
                }
            }
        }
        return Ok(());
    }
    #[allow(unreachable_code)]
    Err("不支持开机启动".into())
}
