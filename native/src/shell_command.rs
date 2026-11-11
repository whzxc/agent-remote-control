//! Shell convenience form over the existing native command executor.
use crate::*;

pub async fn run(c: &control::Control, args: &Value) -> Result<Value> {
    let directory = crate::projects::working_directory(c, args).await?;
    let cwd = Path::new(directory.as_str().unwrap_or(""));
    if !cwd.is_absolute() {
        return Err("ABSOLUTE_CWD_REQUIRED".into());
    }
    if crate::permissions::protected_path(cwd)
        || cwd
            .canonicalize()
            .is_ok_and(|path| crate::permissions::protected_path(&path))
    {
        crate::permissions::require_command_access(
            crate::permissions::command_disk_access(c).await,
        )?;
    }
    if !cwd.is_dir() {
        return Err("ABSOLUTE_CWD_REQUIRED".into());
    }
    #[cfg(unix)]
    let shell = {
        let inherited = std::env::var("SHELL").ok().filter(|s| !s.is_empty());
        inherited
            .or_else(|| unsafe {
                let user = libc::getpwuid(libc::geteuid());
                if user.is_null() || (*user).pw_shell.is_null() {
                    None
                } else {
                    Some(
                        std::ffi::CStr::from_ptr((*user).pw_shell)
                            .to_string_lossy()
                            .into_owned(),
                    )
                }
            })
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "/bin/sh".into())
    };
    #[cfg(windows)]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".into());
    let argv = if cfg!(windows) {
        json!([shell, "/d", "/s", "/c", args["cmd"]])
    } else {
        json!([shell, "-lc", args["cmd"]])
    };
    let started = std::time::Instant::now();
    let timeout = num(args, "timeoutMs", 60000) as u64;
    let output = c
        .request(
            "command/exec",
            json!({"command":argv,"cwd":cwd,"timeoutMs":timeout,"disableOutputCap":true}),
            timeout.saturating_add(5000),
        )
        .await?;
    let mut result = json!({"stdout":output["stdout"],"stderr":output["stderr"],"exitCode":output["exitCode"],"durationMs":started.elapsed().as_millis() as u64,"truncated":false});
    if let Some(hint) = output.get("networkHint") {
        result["networkHint"] = hint.clone();
    }
    if let Some(signal) = output.get("signal") {
        result["signal"] = signal.clone();
    }
    budget(result, args)
}

pub(crate) fn budget(mut result: Value, args: &Value) -> Result<Value> {
    let budget = args["outputBudget"].as_u64().map(|n| n as usize);
    let bytes = string(&result, "stdout")
        .len()
        .saturating_add(string(&result, "stderr").len());
    let paged = crate::kernel::results::page_output(
        result.clone(),
        if budget.is_some_and(|n| bytes > n) {
            0
        } else {
            64 * 1024
        },
    )?;
    if paged["outputId"].is_string() {
        let mut remaining = budget.unwrap_or(usize::MAX);
        for key in ["stdout", "stderr"] {
            let text = string(&result, key);
            let mut end = text
                .len()
                .min(if budget.is_some() { remaining } else { 12000 });
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            remaining = remaining.saturating_sub(end);
            result[key] = json!(&text[..end]);
        }
        result["truncated"] = json!(true);
        result["output"] = json!({"outputId":paged["outputId"],"offset":0,"nextAction":"control_output","format":"JSON with complete stdout/stderr","expiresInSeconds":paged["expiresInSeconds"]});
    }
    Ok(result)
}

/// Diagnose only the observed errno/private-address combination; upstream policy stays authoritative.
pub(crate) fn local_network_hint(result: &Value, args: &Value) -> Option<Value> {
    let output = format!("{}\n{}", string(result, "stdout"), string(result, "stderr"));
    if !output.contains("EHOSTUNREACH") {
        return None;
    }
    let evidence = format!("{output}\n{}", args["command"]);
    let private = evidence
        .split(|c: char| !c.is_ascii_hexdigit() && c != '.' && c != ':')
        .filter_map(|part| {
            part.parse::<std::net::IpAddr>().ok().or_else(|| {
                part.parse::<std::net::SocketAddr>()
                    .ok()
                    .map(|socket| socket.ip())
            })
        })
        .any(|ip| match ip {
            std::net::IpAddr::V4(ip) => ip.is_private() || ip.is_link_local(),
            std::net::IpAddr::V6(ip) => {
                ip.is_unique_local()
                    || ip.is_unicast_link_local()
                    || ip
                        .to_ipv4_mapped()
                        .is_some_and(|ip| ip.is_private() || ip.is_link_local())
            }
        });
    private.then(|| json!({"code":"MACOS_LOCAL_NETWORK_ACCESS",
        "likelyCause":"macOS Local Network privacy or the Codex execution host's inherited sandbox may deny third-party binaries even when a system tool reaches the same LAN address.",
        "responsibleApplication":"Agent Remote Control for the bundled launch chain. Standalone hosts use their own launch identity.",
        "nextAction":"Inspect System Settings > Privacy & Security > Local Network for the responsible application and the native command sandbox policy. An enabled ARC entry alone may not resolve this. Compare the same target with /usr/bin/curl and run the authorized command from Terminal if needed."}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn private_host_unreachable_results_explain_macos_execution_attribution() {
        // Regression: ax-27b483b8 native Node LAN failures returned EHOSTUNREACH without a permission or execution-host hint.
        let args = json!({"command":["node","-e","fetch('http://192.168.50.10/')"]});
        let output = json!({"stdout":"EHOSTUNREACH","stderr":"","exitCode":0});
        let hint = local_network_hint(&output, &args).unwrap();
        assert_eq!(hint["code"], "MACOS_LOCAL_NETWORK_ACCESS");
        assert!(string(&hint, "responsibleApplication").contains("Agent Remote Control"));
        assert!(string(&hint, "likelyCause").contains("Codex"));
        assert!(
            local_network_hint(&json!({"stderr":"EHOSTUNREACH 203.0.113.1"}), &json!({})).is_none()
        );
    }
}
