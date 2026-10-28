//! Fixed local desktop operations, shared by the frontend and authenticated CLI.
use arc_core::transport::{DesktopAccess, DesktopRequest};
use serde_json::{json, Value};
use tauri::Manager;

pub struct Owner(pub tauri::AppHandle);
pub fn check_write(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .state::<crate::updates::UpdateState>()
        .installing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("Installing an update. Wait for the app to restart.".into());
    }
    Ok(())
}
impl DesktopAccess for Owner {
    fn check_write(&self) -> Result<(), String> {
        check_write(&self.0)
    }
    fn request(
        &self,
        operation: DesktopRequest,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<Value, String>> + Send>> {
        let app = self.0.clone();
        Box::pin(async move { request(&app, operation).await })
    }
}

pub async fn request(app: &tauri::AppHandle, operation: DesktopRequest) -> Result<Value, String> {
    let _permit = arc_core::transport::desktop_request_permit()?;
    if let DesktopRequest::Route(route, method, body) = &operation {
        if method != "GET" {
            check_write(app)?;
        }
        if route.starts_with("src-containers/") {
            #[cfg(target_os = "macos")]
            return crate::src_conversations::request(app, route, body.clone()).await;
            #[cfg(not(target_os = "macos"))]
            return Ok(json!({"status":"unsupported","profiles":[]}));
        }
        match (method.as_str(), route.as_str()) {
            ("GET", "permissions/desktop") => return Ok(crate::permissions::status().await),
            ("POST", "permissions/notify") => return crate::permissions::notify(app, body).await,
            ("POST", "app/snapshot") => return crate::snapshot::capture(app, body).await,
            ("GET", "app") => {
                return Ok(
                    json!({"pid":std::process::id(),"bundleId":app.config().identifier,"appName":app.config().product_name,"version":env!("ARC_BUILD_VERSION"),"executable":std::env::current_exe().map_err(|e|e.to_string())?,"build":arc_core::runtime::process_build_id()?}),
                )
            }
            ("GET", "updates") => return Ok(crate::updates::snapshot(app)),
            ("POST", "updates/check") => return crate::updates::check_update(app.clone()).await,
            ("POST", "updates/download") => {
                return crate::updates::download_update(
                    app.clone(),
                    body["version"].as_str().ok_or("version required")?.into(),
                )
                .await
            }
            ("POST", "updates/install") => {
                return crate::updates::install_update(
                    app.clone(),
                    body["version"].as_str().ok_or("version required")?.into(),
                    body["when"].as_str().unwrap_or("settled"),
                )
                .await
            }
            ("POST", "updates/cancel") => {
                crate::updates::cancel_update(app.clone());
                return Ok(crate::updates::snapshot(app));
            }
            ("POST", "app/quit" | "app/restart") => {
                let restart = route == "app/restart";
                let service = app
                    .state::<std::sync::Arc<arc_core::runtime::Client>>()
                    .inner()
                    .clone();
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
                    // Drain while the event loop can still serve in-flight desktop
                    // requests. Waiting for them from RunEvent::Exit can deadlock.
                    service.close().await;
                    app.state::<crate::updates::UpdateState>()
                        .restarting
                        .store(true, std::sync::atomic::Ordering::SeqCst);
                    if restart {
                        app.request_restart();
                    } else {
                        app.exit(0);
                    }
                });
                return Ok(
                    json!({"accepted":true,"state":if restart {"restarting"} else {"quitting"},"pid":std::process::id()}),
                );
            }
            #[cfg(target_os = "macos")]
            (_, "appearance") => {
                return crate::appearance::request(app, method, body.clone()).await
            }
            _ => return Err("UNSUPPORTED_OPERATION".into()),
        }
    }
    match &operation {
        DesktopRequest::ServiceGet => {
            return Ok(
                json!({"supported":cfg!(target_os="macos") || cfg!(windows),"enabled":crate::autostart::enabled().await}),
            )
        }
        DesktopRequest::ServiceSet(body) => {
            check_write(app)?;
            if !body.is_object() || body.as_object().unwrap().keys().any(|key| key != "enabled") {
                return Err("invalid service request".into());
            }
            let enabled = body["enabled"].as_bool().ok_or("invalid enabled")?;
            crate::autostart::set(enabled).await?;
            return Ok(json!({"supported":true,"enabled":enabled}));
        }
        _ => {}
    }
    // Validation reads the existing in-memory registry snapshot, never credentials.
    if let DesktopRequest::SubscriptionsOpen(body) = &operation {
        if !body.is_object() || body.as_object().unwrap().keys().any(|k| k != "providerId") {
            return Err("invalid subscriptions open request".into());
        }
        if let Some(id) = body.get("providerId") {
            let id = id
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("unknown subscription provider")?;
            let service = app
                .state::<std::sync::Arc<arc_core::runtime::Client>>()
                .inner()
                .clone();
            let snapshot = service.subscriptions().await?;
            if !snapshot["providers"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|p| p["providerId"] == id))
            {
                return Err("unknown subscription provider".into());
            }
        }
    }
    let handle = app.clone();
    let (sent, received) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        // A timed-out queued write must not run later when the UI becomes free.
        if sent.is_closed() {
            return;
        }
        let result = (|| {
            check_write(&handle)?;
            match operation {
                DesktopRequest::Route(..)
                | DesktopRequest::ServiceGet
                | DesktopRequest::ServiceSet(_) => unreachable!(),
                DesktopRequest::SubscriptionsOpen(body) => {
                    open(&handle, body["providerId"].as_str().unwrap_or(""))
                }
            }
        })();
        let _ = sent.send(result);
    })
    .map_err(|e| e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(5), received)
        .await
        .map_err(|_| {
            "desktop request timed out; read current state before retrying a write".to_owned()
        })?
        .map_err(|_| "desktop owner unavailable".to_owned())?
}

pub fn open(app: &tauri::AppHandle, provider: &str) -> Result<Value, String> {
    check_write(app)?;
    crate::windows::show(app, Some(("subscriptions:open".into(), json!(provider))))?;
    Ok(json!({"opened":true,"providerId":provider,"pid":std::process::id()}))
}
