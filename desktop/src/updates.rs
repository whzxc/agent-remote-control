//! ARC lifecycle and proxy integration for the official updater resources.
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;
use tauri_plugin_updater::UpdaterExt;

#[derive(Default)]
pub struct State {
    pub closing: AtomicBool,
    replacement: std::sync::Mutex<Option<std::fs::File>>,
}

#[tauri::command]
pub async fn check_update(window: tauri::WebviewWindow) -> Result<Option<Value>, String> {
    let app = window.app_handle();
    if app.config().identifier != "com.whzxc.agent-remote-control" {
        return Ok(None);
    }
    let service = app.state::<std::sync::Arc<arc_core::runtime::Client>>();
    let proxy = service.network_proxy().await?;
    // The JS check options cannot express ARC's per-scheme proxies and direct mode.
    let update = app
        .updater_builder()
        .configure_client(move |builder| proxy.client(builder))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await;
    let update = match update {
        Ok(Some(update)) => update,
        Ok(None)
        | Err(
            tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_),
        ) => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let mut metadata = json!({"currentVersion":update.current_version,"version":update.version,"date":update.date.map(|date|date.to_string()),"body":update.body,"rawJson":update.raw_json});
    let rid = window.resources_table().add(update);
    metadata["rid"] = json!(rid);
    Ok(Some(metadata))
}

#[tauri::command]
pub async fn prepare_update(app: tauri::AppHandle) -> Result<(), String> {
    let state = app.state::<State>();
    if state.closing.swap(true, Ordering::SeqCst) {
        return Err("The app is already shutting down.".into());
    }
    let service = app.state::<std::sync::Arc<arc_core::runtime::Client>>();
    if let Err(error) = service.shutdown().await {
        service.resume().await;
        state.closing.store(false, Ordering::SeqCst);
        return Err(error);
    }
    match arc_core::front_door::process::prepare_update().await {
        Ok(guard) => *state.replacement.lock().unwrap() = Some(guard),
        Err(error) => {
            service.resume().await;
            state.closing.store(false, Ordering::SeqCst);
            return Err(error);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn resume_after_update_failure(app: tauri::AppHandle) {
    app.state::<State>().replacement.lock().unwrap().take();
    app.state::<std::sync::Arc<arc_core::runtime::Client>>()
        .resume()
        .await;
    app.state::<State>().closing.store(false, Ordering::SeqCst);
}
