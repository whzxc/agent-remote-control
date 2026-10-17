use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};

// The WebView resolves Auto and persists the preference with other UI settings.
// Native menus and setup share the resolved Auto locale.
static CHINESE: AtomicBool = AtomicBool::new(false);
static EN: OnceLock<Value> = OnceLock::new();
static ZH: OnceLock<Value> = OnceLock::new();

#[tauri::command]
pub async fn set_ui_locale(app: tauri::AppHandle, locale: String) -> Result<(), String> {
    CHINESE.store(locale == "zh-CN", Ordering::Relaxed);
    crate::request(
        &app,
        "preferences",
        "PUT",
        serde_json::json!({"values":{"resolved-language":locale}}),
    )
    .await?;
    Ok(())
}

pub fn t(key: &str) -> &str {
    let en = EN.get_or_init(|| {
        serde_json::from_str(include_str!("../../ui/locales/en.json"))
            .expect("English UI resources")
    });
    let translated = if CHINESE.load(Ordering::Relaxed) {
        let zh = ZH.get_or_init(|| {
            serde_json::from_str(include_str!("../../ui/locales/zh-CN.json"))
                .expect("Chinese UI resources")
        });
        zh[key].as_str()
    } else {
        None
    };
    translated.or_else(|| en[key].as_str()).unwrap_or(key)
}
