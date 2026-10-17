//! Deep links select a local request; they never authorize or fetch a remote URL.
use serde_json::json;
use tauri_plugin_deep_link::DeepLinkExt;

fn open(app: &tauri::AppHandle, url: &tauri::Url) {
    if url.scheme() != "agent-remote-control"
        || !["", "/"].contains(&url.path())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return;
    }
    let params: Vec<_> = url.query_pairs().collect();
    match url.host_str() {
        Some("ingress") => {
            let id = params
                .iter()
                .find(|(key, _)| key == "id")
                .map(|(_, v)| v.as_ref())
                .unwrap_or("");
            let field = params
                .iter()
                .find(|(key, _)| key == "field")
                .map(|(_, v)| v.as_ref())
                .unwrap_or("");
            if !id.is_empty() {
                let _ = crate::windows::show(
                    app,
                    Some(("ingress:edit".into(), json!({"id":id,"field":field}))),
                );
            }
            return;
        }
        Some("settings")
            if params
                .iter()
                .any(|(k, v)| k == "section" && v == "permissions") =>
        {
            let _ = crate::windows::show(app, Some(("permissions:open".into(), json!(null))));
            return;
        }
        Some("setup")
            if params
                .iter()
                .any(|(k, v)| k == "target" && v == "codex-login") =>
        {
            let _ = crate::windows::show(app, Some(("codex:login".into(), json!(null))));
            return;
        }
        Some("oauth") => {}
        _ => return,
    }

    if params.len() != 1 || params[0].0 != "request" {
        return;
    }
    let request = params[0].1.as_ref();
    if request.len() != 64 || !request.bytes().all(|c| c.is_ascii_hexdigit()) {
        return;
    }
    let _ = crate::windows::show(app, Some(("oauth:open".into(), json!(request))));
}

pub fn install(app: &tauri::AppHandle) -> Result<(), String> {
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| {
        for url in event.urls() {
            open(&handle, &url);
        }
    });
    if let Some(urls) = app.deep_link().get_current().map_err(|e| e.to_string())? {
        for url in urls {
            open(app, &url);
        }
    }
    Ok(())
}
