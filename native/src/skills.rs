use crate::{json, Result, Value};
use std::{
    fs,
    path::{Path, PathBuf},
};

fn source() -> Result<PathBuf> {
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().unwrap();
    // Linux / Windows desktop, bundled Core, and macOS desktop respectively.
    for relative in [
        "skills/arc-setup",
        "../skills/arc-setup",
        "../Resources/skills/arc-setup",
    ] {
        let path = directory.join(relative);
        if path.join("SKILL.md").is_file() {
            return Ok(path);
        }
    }
    #[cfg(debug_assertions)]
    {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../skills/arc-setup");
        if path.join("SKILL.md").is_file() {
            return Ok(path);
        }
    }
    Err("ARC skill resources not found beside the installed executable".into())
}

pub fn playbook(id: &str) -> Result<Value> {
    let file = match id {
        "protocol" | "choose-goal" | "choose-address" | "choose-provider" | "cloudflare-tunnel"
        | "chatgpt-prereq" | "create-ingress" => "protocol",
        "add-connector" | "consent" | "verify-connector" | "loop-test" | "address-secret"
        | "tunnel-credentials" | "enable-in-chatgpt" | "codex-ready" | "permissions"
        | "cloudflare-login" | "claude-code-ready" => id,
        _ => return Err(format!("INVALID_ARGUMENT: unknown playbook {id}")),
    };
    let markdown = fs::read_to_string(source()?.join("playbooks").join(format!("{file}.md")))
        .map_err(|e| e.to_string())?;
    Ok(json!({"id":id,"markdown":markdown}))
}

fn copy(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let target = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), target)?;
        }
    }
    Ok(())
}

pub fn install(target: &str) -> Result<Value> {
    let agent = match target {
        "codex" => ".codex",
        "claude-code" => ".claude",
        _ => return Err("INVALID_ARGUMENT: target must be codex or claude-code".into()),
    };
    let source = source()?;
    let destination = dirs::home_dir()
        .ok_or("home directory unavailable")?
        .join(agent)
        .join("skills/arc-setup");
    if destination.exists() {
        fs::remove_dir_all(&destination).map_err(|e| e.to_string())?;
    }
    copy(&source, &destination).map_err(|e| e.to_string())?;
    Ok(json!({"target":target,"path":destination}))
}
