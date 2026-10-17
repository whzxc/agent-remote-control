//! macOS application entry-point visibility, owned by the desktop process.
use arc_core::{load, root, save};
use serde_json::{json, Value};
use tauri::Manager;
use tokio::sync::Mutex;

struct Preferences(Mutex<Value>);

pub fn install(app: &mut tauri::App) -> Result<(), String> {
    let file = root().join("desktop-appearance.json");
    let mut settings = if file.exists() {
        load(&file)?
    } else {
        json!({"showMenuBar":true,"showDock":true})
    };
    // The three display locations always retain at least one application entry point.
    if settings["showMenuBar"] == false && settings["showDock"] == false {
        settings["showMenuBar"] = json!(true);
        settings["showDock"] = json!(true);
        save(&file, &settings)?;
    }
    validate(&settings)?;
    app.set_dock_visibility(settings["showDock"].as_bool().unwrap());
    app.tray_by_id("main-tray")
        .ok_or("菜单栏图标尚未就绪")?
        .set_visible(settings["showMenuBar"].as_bool().unwrap())
        .map_err(|e| e.to_string())?;
    app.manage(Preferences(Mutex::new(settings)));
    Ok(())
}
fn validate(settings: &Value) -> Result<(), String> {
    if settings.as_object().is_none_or(|o| o.len() != 2)
        || !settings["showMenuBar"].is_boolean()
        || !settings["showDock"].is_boolean()
        || (settings["showMenuBar"] == false && settings["showDock"] == false)
    {
        return Err("显示设置无效".into());
    }
    Ok(())
}
fn apply(app: &tauri::AppHandle, settings: &Value) -> Result<(), String> {
    app.tray_by_id("main-tray")
        .ok_or("菜单栏图标尚未就绪")?
        .set_visible(settings["showMenuBar"].as_bool().unwrap())
        .map_err(|e| e.to_string())?;
    app.set_dock_visibility(settings["showDock"].as_bool().unwrap())
        .map_err(|e| e.to_string())
}
pub async fn request(app: &tauri::AppHandle, method: &str, body: Value) -> Result<Value, String> {
    let state = app.state::<Preferences>();
    let mut current = state.0.lock().await;
    if method == "GET" {
        return Ok(current.clone());
    }
    if method != "PUT" {
        return Err("不支持的显示设置操作".into());
    }
    validate(&body)?;
    if let Err(error) = apply(app, &body) {
        let _ = apply(app, &current);
        return Err(error);
    }
    if let Err(error) = save(&root().join("desktop-appearance.json"), &body) {
        let _ = apply(app, &current);
        return Err(error);
    }
    *current = body;
    Ok(current.clone())
}
