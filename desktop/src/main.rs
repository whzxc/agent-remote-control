#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use connector_core::runtime::Client as Service;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
#[cfg(target_os = "macos")]
mod appearance;
mod autostart;
mod desktop_access;
mod i18n;
mod oauth_links;
mod session;
mod tray;
mod updates;
mod usage_panel;
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
    if connector_core::management::desktop_route(route) {
        return desktop_access::request(
            app,
            connector_core::transport::DesktopRequest::Route(route.into(), method.into(), body),
        )
        .await;
    }
    if route == "usage-panel/geometry" && method == "POST" {
        usage_panel::geometry(app, body).await?;
        return Ok(json!({"accepted":true}));
    }
    if route == "usage-panel/ready" && method == "POST" {
        usage_panel::ready(app);
        return Ok(json!({"ready":true}));
    }
    if route == "usage-panel" && ["GET", "PUT"].contains(&method) {
        let operation = if method == "GET" {
            connector_core::transport::DesktopRequest::PanelGet
        } else {
            connector_core::transport::DesktopRequest::PanelSet(body)
        };
        return desktop_access::request(app, operation).await;
    }
    if route == "subscriptions/open" && method == "POST" {
        return desktop_access::request(
            app,
            connector_core::transport::DesktopRequest::SubscriptionsOpen(body),
        )
        .await;
    }
    app.try_state::<Arc<Service>>()
        .ok_or("Core 尚未就绪")?
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
    let binary = connector_core::runtime::binary()?;
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
        .map_err(|_| format!("更新后等待 Core 就绪超时：{last_error}"))?
    } else {
        Service::connect(binary, "desktop").await?
    };
    let attached = async {
        let (endpoint, listener) =
            connector_core::transport::listen_desktop(Arc::new(desktop_access::Owner(app.clone())))
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
            runtime.block_on(connector_core::cli::run(std::env::args().skip(2).collect())),
        );
    }
    if std::env::args().nth(1).as_deref() == Some("stdio") {
        let runtime = tokio::runtime::Runtime::new().expect("MCP runtime");
        if let Err(error) = runtime.block_on(connector_core::transport::stdio()) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        return;
    }
    tauri::Builder::default()
        .manage(updates::UpdateState::default())
        .manage(windows::MainState::default())
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
                .with_denylist(&["usage-rail"])
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
            i18n::set_ui_locale,
            #[cfg(target_os = "windows")]
            windows_frame::set_windows_appearance
        ])
        .setup(|app| {
            updates::start(app.handle().clone());
            #[cfg(all(debug_assertions, unix))]
            if std::env::var_os("ARC_DEV_SUPERVISED").is_some() {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    use std::io::Read;
                    let mut byte = [0];
                    while std::io::stdin().read(&mut byte).is_ok_and(|n| n > 0) {}
                    handle.exit(0);
                });
                let handle = app.handle().clone();
                let (mut terminate, mut interrupt) = tauri::async_runtime::block_on(async {
                    Ok::<_, std::io::Error>((
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())?,
                        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::interrupt())?,
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
            let service = match tauri::async_runtime::block_on(connect_service(app.handle())) {
                Ok(service) => service,
                Err(error) => {
                    connector_core::logs::record(
                        "ERROR",
                        &format!("Desktop 启动失败：{error}"),
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
                        .title("Agent Remote Control 启动失败")
                        .kind(tauri_plugin_dialog::MessageDialogKind::Error)
                        .show(move |_| handle.exit(1));
                    return Ok(());
                }
            };
            app.manage(service.clone());
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
            windows::install(app.handle());
            oauth_links::install(app.handle()).map_err(std::io::Error::other)?;
            usage_panel::install(app.handle());
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
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if !cfg!(debug_assertions)
                    || window
                        .app_handle()
                        .get_webview_window("usage-rail")
                        .is_some()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Agent Remote Control 启动失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested {
                code: None, api, ..
            } = &event
            {
                api.prevent_exit();
            }
            if let tauri::RunEvent::Exit = event {
                usage_panel::close();
                // The updater already drained the service before replacing the
                // app. Do not block the event loop on a second async shutdown.
                if !app
                    .state::<updates::UpdateState>()
                    .restarting
                    .load(std::sync::atomic::Ordering::SeqCst)
                {
                    if let Some(service) = app.try_state::<Arc<Service>>() {
                        tauri::async_runtime::block_on(async {
                            if let Err(error) = session::remember(service.inner()).await {
                                service.log("ERROR", &error).await;
                            }
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
