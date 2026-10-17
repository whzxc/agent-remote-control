use serde_json::{json, Value};

#[cfg(target_os = "macos")]
#[link(name = "UserNotifications", kind = "framework")]
extern "C" {}

#[cfg(target_os = "macos")]
async fn notification(request: bool) -> Result<&'static str, String> {
    use block2::RcBlock;
    use objc2::{
        class, msg_send,
        runtime::{AnyObject, Bool},
    };
    let (tx, rx) = tokio::sync::oneshot::channel();
    let tx = std::sync::Mutex::new(Some(tx));
    unsafe {
        let center: *mut AnyObject =
            msg_send![class!(UNUserNotificationCenter), currentNotificationCenter];
        if request {
            let callback = RcBlock::new(move |granted: Bool, _error: *mut AnyObject| {
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(if granted.as_bool() {
                        "granted"
                    } else {
                        "missing"
                    });
                }
            });
            let _: () = msg_send![center, requestAuthorizationWithOptions: 7usize, completionHandler: &*callback];
        } else {
            let callback = RcBlock::new(move |settings: *mut AnyObject| {
                let state: isize = msg_send![settings, authorizationStatus];
                if let Some(tx) = tx.lock().unwrap().take() {
                    let _ = tx.send(match state {
                        2 | 3 | 4 => "granted",
                        0 | 1 => "missing",
                        _ => "unknown",
                    });
                }
            });
            let _: () = msg_send![center, getNotificationSettingsWithCompletionHandler: &*callback];
        }
    }
    tokio::time::timeout(std::time::Duration::from_secs(60), rx)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

pub async fn status() -> Value {
    #[cfg(target_os = "macos")]
    let state = notification(false).await.unwrap_or("unknown");
    #[cfg(not(target_os = "macos"))]
    let state = "not-applicable";
    json!({"items":[{"id":"notifications","state":state,"process":"Desktop"},
        crate::autostart::readiness().await]})
}

pub async fn request(id: &str) -> Result<Value, String> {
    #[cfg(target_os = "macos")]
    {
        let panel = match id {
            "accessibility" => "com.apple.preference.security?Privacy_Accessibility",
            "screen-recording" => "com.apple.preference.security?Privacy_ScreenCapture",
            "full-disk-access" | "command-full-disk-access" => {
                "com.apple.preference.security?Privacy_AllFiles"
            }
            "notifications" => "com.apple.Notifications-Settings.extension",
            "login-start" => "com.apple.LoginItems-Settings.extension",
            _ => return Err("UNKNOWN_PERMISSION".into()),
        };
        if id == "notifications" {
            notification(true).await?;
        }
        if matches!(id, "accessibility" | "screen-recording") {
            connector_core::screen::call(json!({"action":"request","permissionId":id})).await?;
        }
        connector_core::command("/usr/bin/open")
            .arg(format!("x-apple.systempreferences:{panel}"))
            .status()
            .await
            .map_err(|e| e.to_string())?;
        return Ok(json!({"requested":true}));
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = id;
        Err("PERMISSION_NOT_APPLICABLE".into())
    }
}

pub async fn notify(app: &tauri::AppHandle, body: &Value) -> Result<Value, String> {
    use tauri_plugin_notification::NotificationExt;
    #[cfg(target_os = "macos")]
    if notification(false).await? != "granted" {
        return Err("NOTIFICATION_PERMISSION_REQUIRED".into());
    }
    app.notification()
        .builder()
        .title(body["title"].as_str().unwrap_or("Agent Remote Control"))
        .body(body["body"].as_str().unwrap_or(""))
        .show()
        .map_err(|e| e.to_string())?;
    Ok(json!({"sent":true}))
}
