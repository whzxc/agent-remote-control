#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use arc_core::runtime::Client as Service;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::DialogExt;
mod app_env;
#[cfg(target_os = "macos")]
mod appearance;
mod autostart;
mod desktop_access;
mod i18n;
mod oauth_links;
mod permissions;
mod session;
mod snapshot;
#[cfg(target_os = "macos")]
mod src_conversations;
mod tray;
mod updates;
mod windows;
#[cfg(target_os = "windows")]
mod windows_frame;

async fn request(
    app: &tauri::AppHandle,
    route: &str,
    method: &str,
    body: Value,
) -> Result<Value, String> {
    if method != "GET" {
        desktop_access::check_write(app)?;
    }
    if route == "permissions/request" && method == "POST" {
        return permissions::request(body["id"].as_str().unwrap_or("")).await;
    }
    if arc_core::management::desktop_route(route) {
        return desktop_access::request(
            app,
            arc_core::transport::DesktopRequest::Route(route.into(), method.into(), body),
        )
        .await;
    }
    app.try_state::<Arc<Service>>()
        .ok_or("Core is not ready")?
        .inner()
        .clone()
        .request(route, method, body)
        .await
}
#[tauri::command]
async fn service_request(
    app: tauri::AppHandle,
    route: String,
    method: String,
    body: Value,
) -> Result<Value, String> {
    request(&app, &route, &method, body).await
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Err(error) = windows::show(app, None) {
        eprintln!("Open window: {error}");
    }
}
async fn connect_service(app: &tauri::AppHandle) -> Result<Arc<Service>, String> {
    let binary = arc_core::runtime::binary()?;
    let service = if updates::pending_resume() {
        // Older updaters may leave a Core behind. Let its lease expire without
        // consuming the recovery marker or crashing the new Desktop.
        let mut last_error = String::new();
        tokio::time::timeout(std::time::Duration::from_secs(25), async {
            loop {
                match Service::connect(binary.clone(), "desktop").await {
                    Ok(service) => break service,
                    Err(error) => last_error = error,
                }
                tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            }
        })
        .await
        .map_err(|_| format!("Timed out waiting for Core after the update: {last_error}"))?
    } else {
        Service::connect(binary, "desktop").await?
    };
    let attached = async {
        let (endpoint, listener) =
            arc_core::transport::listen_desktop(Arc::new(desktop_access::Owner(app.clone())))
                .await?;
        if let Err(error) = service.attach_desktop(endpoint).await {
            listener.abort();
            return Err(error);
        }
        Ok::<_, String>(())
    }
    .await;
    if let Err(error) = attached {
        service.close().await;
        return Err(error);
    }
    Ok(service)
}
fn main() {
    if let Some(state_dir) = std::env::args()
        .skip_while(|arg| arg != "--state-dir")
        .nth(1)
    {
        std::env::set_var("ARC_STATE_DIR", state_dir);
    }
    if std::env::args().nth(1).as_deref() == Some("cli") {
        let runtime = tokio::runtime::Runtime::new().expect("CLI runtime");
        std::process::exit(
            runtime.block_on(arc_core::cli::run(std::env::args().skip(2).collect())),
        );
    }
    if std::env::args().nth(1).as_deref() == Some("stdio") {
        let runtime = tokio::runtime::Runtime::new().expect("MCP runtime");
        if let Err(error) = runtime.block_on(arc_core::transport::stdio()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    let mut context = tauri::generate_context!();
    let identifier = &context.config().identifier;
    let background = std::env::var_os("ARC_DEV_INSTANCE_ID").is_some()
        || identifier == "com.whzxc.agent-remote-control.dev"
        || identifier.starts_with("com.whzxc.agent-remote-control.dev.acceptance-");
    if background {
        for window in &mut context.config_mut().app.windows {
            window.focus = false;
        }
    }
    let builder = tauri::Builder::default();
    #[cfg(target_os = "macos")]
    let builder = if background {
        builder.activate_ignoring_other_apps(false)
    } else {
        builder
    };
    builder
        .manage(updates::UpdateState::default())
        .manage(windows::MainState::default())
        .manage(snapshot::State::default())
        .manage(app_env::State::default())
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::all()
                        & !(tauri_plugin_window_state::StateFlags::VISIBLE
                            | tauri_plugin_window_state::StateFlags::DECORATIONS),
                )
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            windows::main_window_ready,
            windows::release_main_window,
            service_request,
            snapshot::snapshot_ready,
            app_env::apply_env_window,
            i18n::set_ui_locale,
            #[cfg(target_os = "windows")]
            windows_frame::set_windows_appearance
        ])
        .setup(|app| {
            arc_core::runtime::process_build_id().map_err(std::io::Error::other)?;
            #[cfg(debug_assertions)]
            if std::env::var_os("ARC_DEV_SUPERVISED").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut byte = [0];
                    while std::io::stdin().read(&mut byte).is_ok_and(|n| n > 0) {}
                    handle.exit(0);
                });
                #[cfg(unix)]
                {
                    let handle = app.handle().clone();
                    let (mut terminate, mut interrupt) = tauri::async_runtime::block_on(async {
                        Ok::<_, std::io::Error>((
                            tokio::signal::unix::signal(
                                tokio::signal::unix::SignalKind::terminate(),
                            )?,
                            tokio::signal::unix::signal(
                                tokio::signal::unix::SignalKind::interrupt(),
                            )?,
                        ))
                    })?;
                    tauri::async_runtime::spawn(async move {
                        tokio::select! {
                            _ = terminate.recv() => {},
                            _ = interrupt.recv() => {},
                        }
                        handle.exit(0);
                    });
                }
            }
            let service = match tauri::async_runtime::block_on(connect_service(app.handle())) {
                Ok(service) => service,
                Err(error) => {
                    arc_core::logs::record(
                        "ERROR",
                        &format!("Desktop startup failed: {error}"),
                        None,
                    );
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    let handle = app.handle().clone();
                    app.dialog()
                        .message(format!(
                            "{error}\n\n请处理后重新打开 Agent Remote Control。"
                        ))
                        .title("Agent Remote Control failed to start")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            app.manage(service.clone());
            updates::start(app.handle().clone());
            let handle = app.handle().clone();
            let subscription_client = service.clone();
            tauri::async_runtime::spawn(async move {
                let mut previous = Value::Null;
                loop {
                    let snapshot = subscription_client
                        .subscriptions()
                        .await
                        .unwrap_or_else(|_| json!({}));
                    if snapshot != previous {
                        let _ = handle.emit_to("main", "subscriptions:changed", &snapshot);
                        previous = snapshot;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                }
            });
            let handle = app.handle().clone();
            let activity_client = service.clone();
            tauri::async_runtime::spawn(async move {
                let mut previous = Value::Null;
                loop {
                    if let Ok(snapshot) = activity_client
                        .request("agents/activity", "GET", json!({}))
                        .await
                    {
                        let mut comparison = snapshot.clone();
                        if let Some(fields) = comparison.as_object_mut() {
                            fields.remove("observedAt");
                        }
                        if comparison != previous {
                            let _ = handle.emit_to("main", "agents:activity", &snapshot);
                            previous = comparison;
                        }
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                }
            });
            let autostart = std::env::args().any(|arg| arg == "--autostart");
            let resume =
                updates::take_resume().or_else(
                    || {
                        if autostart {
                            None
                        } else {
                            session::restore()
                        }
                    },
                );
            if resume.is_some() || autostart {
                tauri::async_runtime::spawn(async move {
                    if let Some(ids) = resume {
                        for id in ids {
                            if let Err(error) = service
                                .request(&format!("ingress/{id}/start"), "POST", json!({}))
                                .await
                            {
                                service.log("ERROR", &error).await;
                            }
                        }
                    } else if let Err(error) = service
                        .request("ingress/start-all", "POST", json!({}))
                        .await
                    {
                        service.log("ERROR", &error).await;
                    }
                });
            }
            if let Some(window) = app.get_webview_window("main") {
                // Clear the live WebView backing as well as the window configuration.
                // On macOS this disables WKWebView's own opaque background.
                window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))?;
            }
            #[cfg(target_os = "macos")]
            src_conversations::install(app.handle());
            windows::install(app.handle());
            oauth_links::install(app.handle()).map_err(std::io::Error::other)?;
            tray::install(app)?;
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                windows_frame::install(&window)?;
            }
            #[cfg(target_os = "macos")]
            appearance::install(app).map_err(std::io::Error::other)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            #[cfg(target_os = "macos")]
            src_conversations::window_event(window, event);
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !cfg!(debug_assertions) {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(context)
        .expect("Agent Remote Control failed to start")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                api.prevent_exit();
            }
            if let tauri::RunEvent::Exit = event {
                // Updates and explicit quit/restart already drained the client
                // while the event loop was available.
                if !app
                    .state::<updates::UpdateState>()
                    .restarting
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    if let Some(service) = app.try_state::<Arc<Service>>() {
                        tauri::async_runtime::block_on(async {
                            service.close().await;
                        });
                    }
                }
            }
            // Tauri sets a static development icon on Ready; let AppKit resolve
            // the bundled Xcode catalog and its native appearances instead.
            #[cfg(all(debug_assertions, target_os = "macos"))]
            if let tauri::RunEvent::Ready = event {
                let mtm = objc2::MainThreadMarker::new().expect("main thread");
                unsafe {
                    objc2_app_kit::NSApplication::sharedApplication(mtm)
                        .setApplicationIconImage(None);
                }
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                show_main_window(app);
            }
            #[cfg(not(target_os = "macos"))]
            let _ = (app, event);
        });
}
