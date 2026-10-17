//! Fixed local desktop operations, shared by the frontend and authenticated CLI.
use connector_core::transport::{DesktopAccess, DesktopRequest};
use serde_json::{json, Value};
use tauri::Manager;

pub struct Owner(pub tauri::AppHandle);
pub fn check_write(app: &tauri::AppHandle) -> Result<(), String> {
    if app
        .state::<crate::updates::UpdateState>()
        .installing
        .load(std::sync::atomic::Ordering::SeqCst)
    {
        return Err("正在安装更新，请等待应用重启。".into());
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
    if let DesktopRequest::Route(route, method, body) = &operation {
        if method != "GET" {
            check_write(app)?;
        }
        match (method.as_str(), route.as_str()) {
            ("GET", "permissions/desktop") => return Ok(crate::permissions::status().await),
            ("POST", "permissions/notify") => return crate::permissions::notify(app, body).await,
            ("GET", "app") => {
                return Ok(
                    json!({"pid":std::process::id(),"version":env!("ARC_BUILD_VERSION"),"executable":std::env::current_exe().map_err(|e|e.to_string())?,"build":connector_core::runtime::build_id(&std::env::current_exe().map_err(|e|e.to_string())?)?}),
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
                    .state::<std::sync::Arc<connector_core::runtime::Client>>()
                    .inner()
                    .clone();
                crate::session::remember(&service).await?;
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
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
        DesktopRequest::ServiceGet => Ok(
            json!({"supported":cfg!(target_os="macos") || cfg!(windows),"enabled":crate::autostart::enabled().await}),
        ),
        DesktopRequest::ServiceSet(body) => {
            check_write(app)?;
            if !body.is_object() || body.as_object().unwrap().keys().any(|key| key != "enabled") {
                return Err("invalid service request".into());
            }
            let enabled = body["enabled"].as_bool().ok_or("invalid enabled")?;
            crate::autostart::set(enabled).await?;
            Ok(json!({"supported":true,"enabled":enabled}))
        }
        DesktopRequest::Route(..) => unreachable!(),
    }
}
