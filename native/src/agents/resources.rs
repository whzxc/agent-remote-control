//! Local timeline assets share the existing project and thread-image boundary.
use super::*;

impl AgentHost {
    pub(crate) async fn resource(&self, control: &control::Control, args: &Value) -> Result<Value> {
        let id = string(args, "id");
        let agent = string(args, "agent");
        let stored = task_path(id)?;
        let external = self.activity.lock().await.external(id);
        let cwd = if stored.exists() {
            let task = load(&stored)?;
            if task["agent"] != agent {
                return Err("TASK_AGENT_MISMATCH".into());
            }
            string(&task, "cwd").to_owned()
        } else if let Some(external) = external.filter(|s| s.agent == agent) {
            string(&external.session, "project").to_owned()
        } else if agent == "codex" {
            let info = control
                .utility()
                .await?
                .call(
                    "thread/read",
                    json!({"threadId":id,"includeTurns":false}),
                    5000,
                )
                .await?;
            string(&info["thread"], "cwd").to_owned()
        } else {
            return Err("TASK_NOT_FOUND".into());
        };
        if cwd.is_empty() {
            return Err("TASK_PROJECT_UNAVAILABLE".into());
        }
        let path = crate::images::local_path(string(args, "path"), id, &cwd)?;
        let file = path.to_str().ok_or("INVALID_PATH")?;
        if args["action"] == "image" {
            let path = path.clone();
            return tokio::task::spawn_blocking(move || {
                let file = path.to_str().ok_or("INVALID_PATH")?;
                let bytes = crate::projects::read_bytes("", file)?;
                let image = crate::images::prepare(&bytes, file, &json!({}))?;
                Ok(json!({"src":format!("data:{};base64,{}", string(&image.content,"mimeType"), string(&image.content,"data"))}))
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        // Reveal instead of executing a document or executable named in a message.
        #[cfg(target_os = "macos")]
        crate::output("/usr/bin/open", &["-R", file]).await?;
        #[cfg(target_os = "windows")]
        crate::output("explorer.exe", &[&format!("/select,{file}")]).await?;
        #[cfg(target_os = "linux")]
        {
            if std::env::var_os("DISPLAY").is_none()
                && std::env::var_os("WAYLAND_DISPLAY").is_none()
            {
                return Err("FILE_REVEAL_UNAVAILABLE: this host has no graphical session.".into());
            }
            crate::output(
                "xdg-open",
                &[path.parent().and_then(Path::to_str).ok_or("INVALID_PATH")?],
            )
            .await?;
        }
        Ok(json!({"revealed":true}))
    }
}
