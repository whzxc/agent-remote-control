//! Read-only readiness probes run in the process that consumes each permission.
use crate::*;

pub fn full_disk_access() -> &'static str {
    if !cfg!(target_os = "macos") {
        return "not-applicable";
    }

    let user = dirs::home_dir().map(|h| h.join("Library/Application Support/com.apple.TCC/TCC.db"));
    for path in user.into_iter().chain(std::iter::once(PathBuf::from(
        "/Library/Application Support/com.apple.TCC/TCC.db",
    ))) {
        match std::fs::File::open(path) {
            Ok(_) => return "granted",
            Err(e)
                if e.kind() == std::io::ErrorKind::PermissionDenied
                    || e.raw_os_error() == Some(1) =>
            {
                return "missing"
            }
            Err(_) => {}
        }
    }
    "unknown"
}

pub async fn status() -> Value {
    let screen = if cfg!(target_os = "macos") {
        crate::screen::call(json!({"action":"status"}))
            .await
            .unwrap_or(json!({}))
    } else {
        json!({"accessibility":"not-applicable","screen-recording":"not-applicable"})
    };
    let mut items = vec![];
    for id in ["accessibility", "screen-recording"] {
        items.push(json!({"id":id,"state":screen[id].as_str().unwrap_or("unknown"),"process":"arc-screen"}));
    }
    items.push(json!({"id":"full-disk-access","state":full_disk_access(),"process":"Core","executable":std::env::current_exe().ok(),"grantTarget":grant_target(),"heuristic":true}));
    let desktop = crate::transport::forward_request("permissions/desktop","GET",json!({})).await.unwrap_or(json!({"items":[{"id":"notifications","state":"unknown","process":"Desktop"},{"id":"login-start","state":"unknown","process":"Desktop"}]}));
    let mut desktop = desktop;
    if !cfg!(target_os = "macos") {
        desktop["items"][0]["state"] = json!("not-applicable");
    }
    if cfg!(target_os = "linux") {
        desktop["items"][1]["state"] = json!("not-applicable");
    }
    if let Some(rows) = desktop["items"].as_array() {
        items.extend(rows.clone());
    }
    items.push(json!({"id":"codex-desktop","state":if crate::desktop::installation().is_some(){"granted"}else{"missing"},"process":"Core","detail":"installation; login is reported separately by existing account diagnostics"}));
    let claude = crate::agents::driver::discover("claude");
    let auth = if let Some(binary) = &claude {
        match tokio::time::timeout(
            std::time::Duration::from_secs(5),
            command(binary).args(["auth", "status", "--json"]).output(),
        )
        .await
        {
            Ok(Ok(out)) => serde_json::from_slice::<Value>(&out.stdout)
                .ok()
                .and_then(|v| v["loggedIn"].as_bool()),
            _ => None,
        }
    } else {
        Some(false)
    };
    items.push(json!({"id":"claude-code","state":match auth {Some(true)=>"granted",Some(false)=>"missing",None=>"unknown"},"installed":claude.is_some(),"process":"Claude CLI"}));
    json!({"observedAt":now(),"items":items})
}

pub fn check_path(path: &Path) -> Result<()> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::CurDir => {}
            _ => normalized.push(component.as_os_str()),
        }
    }
    let path = normalized.as_path();
    let home = dirs::home_dir().unwrap_or_default();
    let protected = [
        "Desktop",
        "Documents",
        "Downloads",
        "Library/Mail",
        "Library/Messages",
        "Library/Safari",
    ]
    .iter()
    .any(|name| path.starts_with(home.join(name)))
        || path.starts_with("/Volumes");
    if protected && full_disk_access() != "granted" {
        return Err(json!({"code":"PERMISSION_REQUIRED","permissionId":"full-disk-access",
            "message":"Open ARC Settings → Permissions & readiness to grant Full Disk Access. / 打开 ARC 设置 → 权限与就绪开启完全磁盘访问。"}).to_string());
    }
    Ok(())
}

pub async fn command_disk_access(c: &control::Control) -> &'static str {
    if !cfg!(target_os = "macos") {
        return "not-applicable";
    }
    let Some(home) = dirs::home_dir() else {
        return "unknown";
    };
    let file = home.join("Library/Application Support/com.apple.TCC/TCC.db");
    let result = c
        .request(
            "command/exec",
            json!({"command":["/bin/sh","-c","if [ -e \"$1\" ]; then exec 3<\"$1\"; else exec 3<\"/Library/Application Support/com.apple.TCC/TCC.db\"; fi","arc-fda-probe",file],"cwd":"/","timeoutMs":3000}),
            5000,
        )
        .await;
    match result {
        Ok(v) if v["exitCode"] == 0 => "granted",
        Ok(v)
            if string(&v, "stderr").contains("Operation not permitted")
                || string(&v, "stderr").contains("Permission denied") =>
        {
            "missing"
        }
        _ => "unknown",
    }
}
pub fn require_command_access(state: &str) -> Result<()> {
    if matches!(state, "granted" | "not-applicable") {
        return Ok(());
    }
    Err(json!({"code":"PERMISSION_REQUIRED","permissionId":"command-full-disk-access","message":"Grant Full Disk Access to ARC App (the bundled Codex execution host); see ARC Settings → Permissions & readiness. / 请在 ARC 设置 → 权限与就绪查看指引，为 ARC App（内置 Codex 执行宿主）开启完全磁盘访问。"}).to_string())
}

pub fn grant_target() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let canonical = exe.canonicalize().unwrap_or(exe);
    Some(
        canonical
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))
            .unwrap_or(&canonical)
            .to_path_buf(),
    )
}
