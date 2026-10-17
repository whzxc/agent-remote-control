//! Shell convenience form over the existing native command executor.
use crate::*;
pub async fn run(c: &control::Control, args: &Value) -> Result<Value> {
    let cwd = Path::new(string(args, "cwd"));
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
    let paged = crate::kernel::results::page_output(result.clone())?;
    if paged["outputId"].is_string() {
        for key in ["stdout", "stderr"] {
            let text = string(&result, key);
            let mut end = text.len().min(12000);
            while !text.is_char_boundary(end) {
                end -= 1;
            }
            result[key] = json!(&text[..end]);
        }
        result["truncated"] = json!(true);
        result["output"] = json!({"outputId":paged["outputId"],"offset":0,"nextAction":"control_output","format":"JSON with complete stdout/stderr","expiresInSeconds":paged["expiresInSeconds"]});
    }
    Ok(result)
}
