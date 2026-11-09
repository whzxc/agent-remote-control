//! Installed browser discovery and argument-safe launching on the Core host.
use crate::*;
use serde::Serialize;

#[derive(Clone, Serialize)]
pub(super) struct Browser {
    pub id: String,
    pub name: String,
    #[serde(skip)]
    path: PathBuf,
    #[cfg(not(target_os = "linux"))]
    #[serde(skip)]
    profile: Option<String>,
}

fn browser(path: PathBuf, name: String) -> Browser {
    Browser {
        id: crate::hash(path.to_string_lossy().as_bytes()),
        name,
        path,
        #[cfg(not(target_os = "linux"))]
        profile: None,
    }
}

pub(super) async fn discover() -> Result<Vec<Browser>> {
    let mut found = Vec::new();
    #[cfg(target_os = "macos")]
    {
        let mut directories = vec![
            PathBuf::from("/Applications"),
            PathBuf::from("/System/Applications"),
        ];
        if let Some(home) = dirs::home_dir() {
            directories.push(home.join("Applications"));
        }
        let mut apps = Vec::new();
        for directory in directories {
            collect_apps(&directory, 2, &mut apps);
        }
        for path in apps {
            let info = path.join("Contents/Info.plist");
            let result = command("/usr/bin/plutil")
                .args(["-convert", "json", "-o", "-"])
                .arg(info)
                .output()
                .await;
            let Ok(result) = result else { continue };
            let Ok(value) = serde_json::from_slice::<Value>(&result.stdout) else {
                continue;
            };
            let handles_web = value["CFBundleURLTypes"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|item| {
                    item["LSHandlerRank"] != "Alternate"
                        && item["LSHandlerRank"] != "None"
                        && item["CFBundleURLSchemes"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|scheme| scheme == "http" || scheme == "https")
                });
            if handles_web {
                let name = value["CFBundleDisplayName"]
                    .as_str()
                    .or_else(|| value["CFBundleName"].as_str())
                    .unwrap_or_else(|| {
                        path.file_stem()
                            .and_then(|p| p.to_str())
                            .unwrap_or("Browser")
                    })
                    .to_owned();
                found.push(browser(path, name));
            }
        }
    }
    #[cfg(windows)]
    {
        // Read registered browser commands; never evaluate a registry command as shell text.
        let script = r#"$items = foreach ($root in @('HKCU:\Software\Clients\StartMenuInternet','HKLM:\Software\Clients\StartMenuInternet','HKLM:\Software\WOW6432Node\Clients\StartMenuInternet')) { Get-ChildItem $root -ErrorAction SilentlyContinue | ForEach-Object { $c = (Get-Item ($_.PSPath + '\shell\open\command') -ErrorAction SilentlyContinue).GetValue(''); if ($c -match '^\s*"([^"]+\.exe)"' -or $c -match '^\s*(.+?\.exe)(?:\s|$)') { $p = [Environment]::ExpandEnvironmentVariables($Matches[1]); if (Test-Path -LiteralPath $p) { @{ name = $_.GetValue(''); path = $p } } } } }; ConvertTo-Json -InputObject @($items) -Compress"#;
        let raw = output(
            "powershell.exe",
            &["-NoProfile", "-NonInteractive", "-Command", script],
        )
        .await?;
        let rows: Vec<Value> = serde_json::from_str(raw.trim_start_matches('\u{feff}'))
            .map_err(|_| "BROWSER_DISCOVERY_FAILED: Could not read registered browsers")?;
        for row in rows {
            if let (Some(path), Some(name)) = (row["path"].as_str(), row["name"].as_str()) {
                found.push(browser(PathBuf::from(path), name.to_owned()));
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        let mut directories = vec![dirs::data_dir()
            .unwrap_or_else(|| PathBuf::from(".local/share"))
            .join("applications")];
        for directory in std::env::var("XDG_DATA_DIRS")
            .unwrap_or_else(|_| "/usr/local/share:/usr/share".into())
            .split(':')
        {
            directories.push(PathBuf::from(directory).join("applications"));
        }
        let mut seen = std::collections::BTreeSet::new();
        for directory in directories {
            let Ok(entries) = std::fs::read_dir(directory) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().is_none_or(|e| e != "desktop")
                    || !seen.insert(entry.file_name())
                {
                    continue;
                }
                let Ok(raw) = std::fs::read_to_string(&path) else {
                    continue;
                };
                let mut section = false;
                let mut fields = std::collections::BTreeMap::new();
                for line in raw.lines() {
                    if line.starts_with('[') {
                        section = line == "[Desktop Entry]";
                    }
                    if section {
                        if let Some((key, value)) = line.split_once('=') {
                            fields.insert(key, value);
                        }
                    }
                }
                if fields.get("Hidden") == Some(&"true") || fields.get("NoDisplay") == Some(&"true")
                {
                    continue;
                }
                if fields.get("Type") != Some(&"Application") {
                    continue;
                }
                if !fields.get("MimeType").is_some_and(|v| {
                    v.split(';')
                        .any(|v| v == "x-scheme-handler/https" || v == "x-scheme-handler/http")
                }) {
                    continue;
                }
                if let Some(name) = fields.get("Name") {
                    found.push(browser(path, (*name).into()));
                }
            }
        }
    }
    #[cfg(not(target_os = "linux"))]
    {
        let profiles = found.iter().flat_map(chrome_profiles).collect::<Vec<_>>();
        found.extend(profiles);
    }
    found.sort_by(|a, b| a.name.cmp(&b.name));
    found.dedup_by(|a, b| a.id == b.id);
    Ok(found)
}

#[cfg(not(target_os = "linux"))]
fn chrome_profiles(browser: &Browser) -> Vec<Browser> {
    #[cfg(target_os = "macos")]
    let state = dirs::home_dir()
        .filter(|_| {
            browser
                .path
                .file_name()
                .is_some_and(|name| name == "Google Chrome.app")
        })
        .map(|home| home.join("Library/Application Support/Google/Chrome/Local State"));
    #[cfg(windows)]
    let state = dirs::data_local_dir()
        .filter(|_| {
            browser
                .path
                .file_name()
                .is_some_and(|name| name.eq_ignore_ascii_case("chrome.exe"))
        })
        .map(|home| home.join("Google/Chrome/User Data/Local State"));
    let Some(state) = state.and_then(|path| load(&path).ok()) else {
        return Vec::new();
    };
    state["profile"]["info_cache"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(dir, _)| {
            !dir.is_empty() && !matches!(dir.as_str(), "." | "..") && !dir.contains(['/', '\\'])
        })
        .map(|(dir, facts)| {
            let name = facts["name"].as_str().unwrap_or(dir);
            Browser {
                id: crate::hash(format!("{}:{dir}", browser.id).as_bytes()),
                name: format!("{} · {name}", browser.name),
                path: browser.path.clone(),
                profile: Some(dir.clone()),
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn collect_apps(directory: &Path, depth: usize, apps: &mut Vec<PathBuf>) {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().is_some_and(|v| v == "app") {
            apps.push(path);
        } else if depth > 0 && entry.file_type().is_ok_and(|t| t.is_dir()) {
            collect_apps(&path, depth - 1, apps);
        }
    }
}

pub(super) async fn open(browser: Option<&Browser>, url: &str) -> Result<()> {
    let parsed = reqwest::Url::parse(url).map_err(|_| "INVALID_LOGIN_URL")?;
    if super::authorization_url(url).is_none()
        && !(parsed.scheme() == "https"
            && parsed.host_str() == Some("auth.openai.com")
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.port_or_known_default() == Some(443))
    {
        return Err("INVALID_LOGIN_URL".into());
    }
    #[cfg(target_os = "macos")]
    let mut cmd = {
        if let Some((browser, profile)) = browser.and_then(|b| b.profile.as_ref().map(|p| (b, p))) {
            let mut cmd = command(browser.path.join("Contents/MacOS/Google Chrome"));
            cmd.arg(format!("--profile-directory={profile}")).arg(url);
            cmd
        } else {
            let mut cmd = command("/usr/bin/open");
            if let Some(browser) = browser {
                cmd.arg("-a").arg(&browser.path);
            }
            cmd.arg(url);
            cmd
        }
    };
    #[cfg(windows)]
    let mut cmd = if let Some(browser) = browser {
        let mut cmd = command(&browser.path);
        if let Some(profile) = &browser.profile {
            cmd.arg(format!("--profile-directory={profile}"));
        }
        cmd.arg(url);
        cmd
    } else {
        let mut cmd = command("rundll32.exe");
        cmd.args(["url.dll,FileProtocolHandler", url]);
        cmd
    };
    #[cfg(target_os = "linux")]
    let mut cmd = if let Some(browser) = browser {
        let mut cmd = command("gio");
        cmd.arg("launch").arg(&browser.path).arg(url);
        cmd
    } else {
        let mut cmd = command("xdg-open");
        cmd.arg(url);
        cmd
    };
    let mut child = cmd
        .kill_on_drop(false)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .map_err(|_| "BROWSER_OPEN_FAILED: Copy the login link and open it in your browser")?;
    if let Ok(result) =
        tokio::time::timeout(std::time::Duration::from_millis(700), child.wait()).await
    {
        if !result.is_ok_and(|status| status.success()) {
            return Err(
                "BROWSER_OPEN_FAILED: Copy the login link and open it in your browser".into(),
            );
        }
    } else {
        tokio::spawn(async move {
            let _ = child.wait().await;
        });
    }
    Ok(())
}
