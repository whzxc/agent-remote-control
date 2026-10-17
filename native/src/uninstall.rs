//! Local uninstall; never exposed through remote MCP or the management catalog.
use crate::*;
use std::{fs, time::Duration};

fn exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

pub async fn run(purge: bool) -> Result<Value> {
    let home = dirs::home_dir().ok_or("Home directory unavailable")?;
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let executable = executable.canonicalize().map_err(|e| e.to_string())?;
    let mut paths = vec![];
    #[allow(unused_mut)]
    let mut warnings: Vec<Value> = vec![];
    // Only historical launchers actually used by this ARC instance belong to it.
    let legacy = home.join(".local/bin/tunnel-client");
    let recorded = load(&root().join("dependencies/legacy-tunnel.json")).unwrap_or(Value::Null);
    let mut owned_legacy = recorded["path"]
        .as_str()
        .is_some_and(|p| Path::new(p) == legacy);
    for id in load(&root().join("ingresses/index.json"))
        .unwrap_or(json!([]))
        .as_array()
        .into_iter()
        .flatten()
    {
        if let Some(id) = id.as_str() {
            let entry =
                load(&root().join("ingresses").join(id).join("config.json")).unwrap_or(Value::Null);
            owned_legacy |= Path::new(string(&entry["config"], "tunnelBinary")) == legacy;
        }
    }
    if owned_legacy {
        paths.push(legacy);
    }
    for agent in [".codex", ".claude"] {
        paths.push(home.join(agent).join("skills/arc-setup"));
    }

    #[cfg(target_os = "macos")]
    let app = executable
        .ancestors()
        .find(|p| p.extension().is_some_and(|e| e == "app"))
        .map(Path::to_path_buf);
    #[cfg(windows)]
    let app = executable
        .ancestors()
        .skip(1)
        .find(|p| {
            p.join("agent-remote-control-desktop.exe").is_file()
                && p.join("uninstall.exe").is_file()
        })
        .map(Path::to_path_buf);
    #[cfg(target_os = "linux")]
    let app: Option<PathBuf> = None;

    #[cfg(target_os = "macos")]
    {
        let plist = home.join("Library/LaunchAgents/com.whzxc.agent-remote-control.plist");
        if exists(&plist) {
            let state = output(
                "/usr/bin/plutil",
                &[
                    "-extract",
                    "EnvironmentVariables.ARC_STATE_DIR",
                    "raw",
                    "-o",
                    "-",
                    plist.to_str().ok_or("Invalid LaunchAgent path")?,
                ],
            )
            .await?;
            if Path::new(state.trim()) == root() {
                let uid = output("/usr/bin/id", &["-u"]).await?;
                let label = format!("gui/{}/com.whzxc.agent-remote-control", uid.trim());
                if output("/bin/launchctl", &["print", &label]).await.is_ok() {
                    output("/bin/launchctl", &["bootout", &label]).await?;
                }
                paths.push(plist);
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let unit = dirs::config_dir()
            .ok_or("XDG config directory unavailable")?
            .join("systemd/user/agent-remote-control.service");
        if exists(&unit) {
            output(
                "systemctl",
                &["--user", "disable", "--now", "agent-remote-control.service"],
            )
            .await?;
            paths.push(unit);
        }
    }
    #[cfg(windows)]
    {
        output("powershell.exe", &["-NoProfile", "-NonInteractive", "-Command",
            "$ErrorActionPreference = 'Stop'; $key = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'; if (Get-ItemProperty -LiteralPath $key -Name 'Agent Remote Control' -ErrorAction SilentlyContinue) { Remove-ItemProperty -LiteralPath $key -Name 'Agent Remote Control' }; exit 0"]).await?;
    }

    // Shut down the actual Desktop and Core before touching state or permissions.
    if let Ok(desktop) = transport::forward_request("app", "GET", json!({})).await {
        transport::forward_request("app/quit", "POST", json!({})).await?;
        let pid = desktop["pid"].as_u64().ok_or("Desktop PID unavailable")?;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
        loop {
            #[cfg(unix)]
            let alive = unsafe { libc::kill(pid as i32, 0) == 0 };
            #[cfg(windows)]
            let alive = output(
                "powershell.exe",
                &[
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    &format!(
                        "if (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ exit 1 }}; exit 0"
                    ),
                ],
            )
            .await
            .is_err();
            if !alive {
                break;
            }
            if tokio::time::Instant::now() >= deadline {
                return Err("ARC did not quit; uninstall stopped".into());
            }
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
    }
    crate::headless::stop().await?;

    #[cfg(target_os = "macos")]
    if let Some(app) = &app {
        let plist = app.join("Contents/Info.plist");
        let bundle = output(
            "/usr/libexec/PlistBuddy",
            &[
                "-c",
                "Print :CFBundleIdentifier",
                plist.to_str().ok_or("Invalid App path")?,
            ],
        )
        .await?;
        let bundle = bundle.trim();
        for id in [
            bundle.to_owned(),
            format!("{bundle}.core"),
            format!("{bundle}.screen"),
        ] {
            // Reset before removing the bundle, while LaunchServices can resolve its identity.
            if let Err(error) = output("/usr/bin/tccutil", &["reset", "All", &id]).await {
                warnings.push(json!({"action":"tccutil reset All","bundleId":id,"error":error}));
            }
            for directory in ["WebKit", "Caches", "Application Support", "HTTPStorages"] {
                paths.push(home.join("Library").join(directory).join(&id));
            }
            paths.push(home.join("Library/Preferences").join(format!("{id}.plist")));
            paths.push(
                home.join("Library/Saved Application State")
                    .join(format!("{id}.savedState")),
            );
        }
    }
    #[cfg(windows)]
    for directory in [dirs::data_dir(), dirs::data_local_dir()]
        .into_iter()
        .flatten()
    {
        paths.push(directory.join("com.whzxc.agent-remote-control"));
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(cache) = dirs::cache_dir() {
            paths.push(cache.join("agent-remote-control"));
        }
        if let Some(config) = dirs::config_dir() {
            paths.push(config.join("agent-remote-control"));
        }
    }
    #[cfg(windows)]
    let installation = app.clone();
    #[cfg(windows)]
    if app.is_some() {
        if let Some(data) = dirs::data_dir() {
            paths.push(data.join("Microsoft/Windows/Start Menu/Programs/Agent Remote Control.lnk"));
        }
        if let Some(desktop) = dirs::desktop_dir() {
            paths.push(desktop.join("Agent Remote Control.lnk"));
        }
    }
    paths.push(root()); // Includes all current managed dependencies and Cloudflare credentials.
    if let Some(app) = app {
        paths.push(app);
    } else {
        if let Some(parent) = executable.parent() {
            paths.push(parent.join("skills/arc-setup"));
        }
        paths.push(executable);
    }
    paths.retain(|p| exists(p));
    paths.sort();
    paths.dedup();
    let parents = paths.clone();
    paths.retain(|p| {
        !parents
            .iter()
            .any(|parent| parent != p && p.starts_with(parent))
    });

    #[cfg(windows)]
    {
        // Windows cannot remove the executing CLI. Finish after it exits and leave a receipt.
        let result = std::env::temp_dir().join(format!("arc-uninstall-{}.json", id()));
        let script = r#"
$ErrorActionPreference = 'Stop'
$plan = $env:ARC_UNINSTALL_PLAN | ConvertFrom-Json
Wait-Process -Id $plan.pid -ErrorAction SilentlyContinue
Add-Type -AssemblyName Microsoft.VisualBasic
$removed = @(); $errors = @()
foreach ($path in $plan.paths) {
  try {
    if ($plan.purge) { Remove-Item -LiteralPath $path -Recurse -Force }
    elseif ([IO.Directory]::Exists($path)) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    else { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($path, 'OnlyErrorDialogs', 'SendToRecycleBin') }
    $removed += $path
  } catch { $errors += @{path=$path; error=$_.Exception.Message} }
}
if ($plan.installation -and !(Test-Path -LiteralPath $plan.installation)) {
  try {
    Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | ForEach-Object {
      $entry = Get-ItemProperty -LiteralPath $_.PSPath
      if ($entry.DisplayName -eq 'Agent Remote Control' -and $entry.InstallLocation -and $entry.InstallLocation.TrimEnd('\') -eq $plan.installation.TrimEnd('\')) {
        Remove-Item -LiteralPath $_.PSPath -Recurse -Force
      }
    }
    $scheme = 'HKCU:\Software\Classes\agent-remote-control'
    $handlerKey = Get-Item -LiteralPath "$scheme\shell\open\command" -ErrorAction SilentlyContinue
    if ($handlerKey -and $handlerKey.GetValue('').Contains($plan.installation)) { Remove-Item -LiteralPath $scheme -Recurse -Force }
  } catch { $errors += @{action='registration cleanup'; error=$_.Exception.Message} }
}
@{state= $(if ($errors.Count) {'incomplete'} else {'completed'}); removed=$removed; errors=$errors; warnings=$plan.warnings} | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $plan.result
"#;
        command("powershell.exe").args(["-NoProfile", "-NonInteractive", "-Command", script])
            .env("ARC_UNINSTALL_PLAN", json!({"pid":std::process::id(),"paths":paths,"purge":purge,"result":result,"warnings":warnings,"installation":installation}).to_string())
            .current_dir(std::env::temp_dir()).kill_on_drop(false).creation_flags(0x08000008).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
            .spawn().map_err(|e| e.to_string())?;
        return Ok(
            json!({"state":"scheduled","purge":purge,"paths":paths,"resultPath":result,"warnings":warnings}),
        );
    }
    #[cfg(not(windows))]
    {
        let mut removed = vec![];
        let mut errors = vec![];
        for path in paths {
            let result = if purge {
                remove(&path)
            } else {
                trash(&path).await
            };
            match result {
                Ok(()) => removed.push(path),
                Err(error) => errors.push(json!({"path":path,"error":error})),
            }
        }
        #[cfg(target_os = "linux")]
        if removed.iter().any(|p| {
            p.file_name()
                .is_some_and(|n| n == "agent-remote-control.service")
        }) {
            if let Err(error) = output("systemctl", &["--user", "daemon-reload"]).await {
                warnings.push(json!({"action":"systemctl --user daemon-reload","error":error}));
            }
        }
        Ok(
            json!({"state":if errors.is_empty() && warnings.is_empty(){"completed"}else{"incomplete"},"purge":purge,"removed":removed,"errors":errors,"warnings":warnings}),
        )
    }
}

#[cfg(not(windows))]
fn remove(path: &Path) -> Result<()> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
    .map_err(|e| e.to_string())
}

#[cfg(target_os = "macos")]
async fn trash(path: &Path) -> Result<()> {
    output(
        "/usr/bin/osascript",
        &[
            "-l",
            "JavaScript",
            "-e",
            r#"
ObjC.import('Foundation');
function run(argv) {
    var error = Ref();
    var ok = $.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(
        $.NSURL.fileURLWithPath(argv[0]), null, error);
    if (!ok) throw Error(ObjC.unwrap(error[0].localizedDescription));
}
"#,
            path.to_str().ok_or("Invalid uninstall path")?,
        ],
    )
    .await?;
    Ok(())
}

#[cfg(target_os = "linux")]
async fn trash(path: &Path) -> Result<()> {
    // Use the freedesktop Trash layout without requiring a GUI or an extra runtime.
    let base = dirs::data_dir()
        .ok_or("XDG data directory unavailable")?
        .join("Trash");
    private_dir(&base.join("files"))?;
    private_dir(&base.join("info"))?;
    let name = format!(
        "{}-{}",
        path.file_name()
            .ok_or("Invalid uninstall path")?
            .to_string_lossy(),
        id()
    );
    let info = base.join("info").join(format!("{name}.trashinfo"));
    let absolute = std::path::absolute(path).map_err(|e| e.to_string())?;
    let encoded = reqwest::Url::from_file_path(&absolute).map_err(|_| "Invalid uninstall path")?;
    fs::write(
        &info,
        format!(
            "[Trash Info]\nPath={}\nDeletionDate={}\n",
            encoded.path(),
            chrono::Local::now().format("%Y-%m-%dT%H:%M:%S")
        ),
    )
    .map_err(|e| e.to_string())?;
    if let Err(error) = fs::rename(path, base.join("files").join(name)) {
        let _ = fs::remove_file(info);
        return Err(format!(
            "Could not move to Trash (source retained): {error}"
        ));
    }
    Ok(())
}
