//! Plain native windows with direct wry children; never Tauri remote webviews.
mod import;
mod jobs;
mod native;
use arc_core::src_conversations::{
    identity::{import_guard, OrgAccount},
    import_state::ImportState,
    refs,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::Manager;
use wry::{WebView, WebViewBuilder, WebViewBuilderExtDarwin};

struct Container {
    view: WebView,
    window: tauri::Window,
    store_id: String,
    safari: bool,
    status: String,
    current: String,
    changed: Instant,
    finished: Arc<AtomicBool>,
}
thread_local! {
    static VIEWS: RefCell<BTreeMap<String,Container>> = const { RefCell::new(BTreeMap::new()) };
    static CLEARING: RefCell<BTreeMap<String,native::Removal>> = const { RefCell::new(BTreeMap::new()) };
    // Retain barriers even if the user closes the window or the caller disconnects.
    static IMPORTS: RefCell<BTreeMap<String,Arc<AtomicUsize>>> = const { RefCell::new(BTreeMap::new()) };
}
async fn main_thread<T: Send + 'static>(
    app: &tauri::AppHandle,
    f: impl FnOnce(&tauri::AppHandle) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        if !tx.is_closed() {
            let _ = tx.send(f(&handle));
        }
    })
    .map_err(|_| "SRC_MAIN_THREAD_UNAVAILABLE")?;
    tokio::time::timeout(Duration::from_secs(5), rx)
        .await
        .map_err(|_| "SRC_MAIN_THREAD_TIMEOUT")?
        .map_err(|_| "SRC_MAIN_THREAD_UNAVAILABLE")?
}
fn check_barrier(store: &str) -> Result<(), String> {
    if CLEARING.with(|slot| slot.borrow().contains_key(store)) {
        return Err("SRC_STORE_CLEAR_PENDING: Retry src_login_clear to confirm data store removal before opening or importing".into());
    }
    IMPORTS.with(|slot| {
        let mut pending = slot.borrow_mut();
        pending.retain(|_, count| count.load(Ordering::SeqCst) != 0);
        if pending.contains_key(store) {
            Err("SRC_IMPORT_BLOCKED: Cookie writes are still pending; wait before retrying".into())
        } else {
            Ok(())
        }
    })
}
fn create(app: &tauri::AppHandle, args: &Value, reset: bool) -> Result<(), String> {
    let account = arc_core::string(args, "accountId");
    let store = arc_core::string(args, "storeId");
    let safari = args["safariUserAgent"] == true;
    check_barrier(store)?;
    VIEWS.with(|slot| {
        let mut views = slot.borrow_mut();
        if let Some(c) = views.get(account) {
            if c.store_id != store {
                return Err("SRC_CONTAINER_IDENTITY_CHANGED: Close the account window and retry".into());
            }
            if !reset {
                if c.safari != safari {
                    return Err("SRC_UA_REOPEN_REQUIRED: Close the account window to apply the saved UA setting".into());
                }
                return Ok(());
            }
        }
        let uuid = uuid::Uuid::parse_str(store).map_err(|_| "SRC_STORE_ID_INVALID")?;
        let label = format!("src-{}", uuid.simple());
        let window = if let Some(old) = views.remove(account) {
            // Re-import unloads the old page but reuses its plain host window.
            drop(old.view);
            old.window
        } else {
            tauri::window::WindowBuilder::new(app, &label)
                .title(arc_core::string(args, "title"))
                .inner_size(1100.0, 800.0)
                .build().map_err(|_| "SRC_WINDOW_FAILED")?
        };
        let size = window.inner_size().map_err(|_| "SRC_WINDOW_SIZE_FAILED")?;
        let finished = Arc::new(AtomicBool::new(false));
        let loaded = finished.clone();
        let mut builder = WebViewBuilder::new()
            .with_data_store_identifier(*uuid.as_bytes())
            .with_bounds(wry::Rect {
                position: wry::dpi::LogicalPosition::new(0., 0.).into(),
                size: wry::dpi::PhysicalSize::new(size.width, size.height).into(),
            })
            .with_navigation_handler(|url| refs::allowed(&url) || url == "about:blank")
            .with_new_window_req_handler(|_, _| wry::NewWindowResponse::Deny)
            .with_on_page_load_handler(move |event, _| {
                loaded.store(matches!(event, wry::PageLoadEvent::Finished), Ordering::SeqCst);
            });
        if safari {
            builder = builder.with_user_agent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15");
        }
        // No URL until import completion; no IPC handler or initialization scripts.
        let view = match builder.build_as_child(&window) {
            Ok(view) => view,
            Err(_) => { let _ = window.destroy(); return Err("SRC_WEBVIEW_FAILED".into()); }
        };
        if native::verify_no_scripts(&view).is_err() {
            drop(view);
            let _ = window.destroy();
            return Err("SRC_UNEXPECTED_USER_SCRIPTS".into());
        }
        views.insert(account.into(), Container {
            view, window, store_id: store.into(), safari,
            status: "not-imported".into(), current: String::new(), changed: Instant::now(), finished,
        });
        Ok(())
    })
}
fn navigate(account: &str, url: &str) -> Result<Value, String> {
    VIEWS.with(|slot| {
        let mut views = slot.borrow_mut();
        let c = views.get_mut(account).ok_or("SRC_WINDOW_CLOSED")?;
        check_barrier(&c.store_id)?;
        c.finished.store(false, Ordering::SeqCst);
        c.changed = Instant::now();
        c.current.clear();
        c.view.load_url(url).map_err(|_| "SRC_NAVIGATION_FAILED")?;
        c.window.show().map_err(|_| "SRC_WINDOW_SHOW_FAILED")?;
        c.window
            .set_focus()
            .map_err(|_| "SRC_WINDOW_FOCUS_FAILED")?;
        Ok(json!({"accountId":account,"status":c.status}))
    })
}
fn metadata() -> Value {
    VIEWS.with(|slot| {
        let mut views = slot.borrow_mut();
        let containers: Vec<_> = views.iter_mut().map(|(account, c)| {
            if let Ok(url) = c.view.url() {
                if c.current != url { c.current = url; c.changed = Instant::now(); }
            }
            if refs::expired(&c.current) { c.status = "expired".into(); }
            else if refs::allowed(&c.current) && c.finished.load(Ordering::SeqCst)
                && c.changed.elapsed() >= Duration::from_secs(5) { c.status = "signed-in".into(); }
            // Never forward arbitrary paths, query strings or fragments to Core.
            let url = refs::conversation(&c.current).map(|r| r["url"].clone()).unwrap_or(Value::Null);
            let active = c.window.is_focused().unwrap_or(false)
                && c.window.is_visible().unwrap_or(false) && !c.window.is_minimized().unwrap_or(true);
            json!({"accountId":account,"storeId":c.store_id,"status":c.status,"url":url,"active":active,"open":true})
        }).collect();
        jobs::jobs().metadata(containers)
    })
}
pub fn install(app: &tauri::AppHandle) {
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            let Some(service) = handle
                .try_state::<Arc<arc_core::runtime::Client>>()
                .map(|s| s.inner().clone())
            else {
                continue;
            };
            let Ok(body) = main_thread(&handle, |_| Ok(metadata())).await else {
                continue;
            };
            let _ = service
                .request("src-conversations/observe", "POST", body)
                .await;
        }
    });
}
pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    if !window.label().starts_with("src-") {
        return;
    }
    VIEWS.with(|slot| {
        let Ok(mut views) = slot.try_borrow_mut() else {
            return;
        };
        if matches!(event, tauri::WindowEvent::Destroyed) {
            views.retain(|_, c| c.window.label() != window.label());
        } else if let tauri::WindowEvent::Resized(size) = event {
            if let Some(c) = views.values().find(|c| c.window.label() == window.label()) {
                let _ = c.view.set_bounds(wry::Rect {
                    position: wry::dpi::LogicalPosition::new(0., 0.).into(),
                    size: wry::dpi::PhysicalSize::new(size.width, size.height).into(),
                });
            }
        }
    });
}
pub async fn request(app: &tauri::AppHandle, route: &str, args: Value) -> Result<Value, String> {
    if !arc_core::src_conversations::platform_supported() {
        return Ok(json!({"status":"unsupported","profiles":[]}));
    }
    if route == "src-containers/status" {
        return main_thread(app, |_| Ok(metadata())).await;
    }
    if route == "src-containers/profiles" {
        return Ok(
            json!({"profiles":import::profiles().map_err(|e| format!("SRC_IMPORT_BLOCKED: {e}"))?}),
        );
    }
    // A clear cannot race another window mutation or a newly admitted import.
    static MUTATIONS: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _mutation=MUTATIONS.try_lock().map_err(|_|"SRC_CONTAINER_BUSY: Another window mutation is in progress; read src_conversations before retrying")?;
    let account = arc_core::string(&args, "accountId").to_owned();
    let store = arc_core::string(&args, "storeId").to_owned();
    if route == "src-containers/clear" {
        if jobs::jobs().in_flight(&account).is_some() {
            return Err("SRC_CONTAINER_BUSY: Wait for the in-flight import to finish before clearing its data store".into());
        }
        let id = account.clone();
        let store_id = store.clone();
        let removed = main_thread(app, move |_| {
            if let Some(removal) = CLEARING.with(|slot| slot.borrow().get(&store).cloned()) {
                if !removal
                    .lock()
                    .unwrap()
                    .is_some_and(|result| result.is_err())
                {
                    return Ok(removal);
                }
                CLEARING.with(|slot| slot.borrow_mut().remove(&store));
            }
            check_barrier(&store)?;
            VIEWS.with(|slot| {
                if let Some(container) = slot.borrow_mut().remove(&id) {
                    drop(container.view);
                    container
                        .window
                        .destroy()
                        .map_err(|_| "SRC_WINDOW_CLOSE_FAILED")?;
                }
                Ok::<(), String>(())
            })?;
            let removal = native::remove_store(&store).map_err(str::to_owned)?;
            CLEARING.with(|slot| slot.borrow_mut().insert(store, removal.clone()));
            Ok(removal)
        })
        .await?;
        tokio::time::timeout(Duration::from_secs(30),async {
            loop {
                if let Some(result)=*removed.lock().unwrap() {return result;}
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }).await.map_err(|_|"SRC_STORE_CLEAR_TIMEOUT: Native website data removal is unconfirmed; retry clear before importing")?
            .map_err(str::to_owned)?;
        main_thread(app, move |_| {
            CLEARING.with(|slot| slot.borrow_mut().remove(&store_id));
            Ok(())
        })
        .await?;
        jobs::jobs().forget(&account);
        return Ok(json!({"accountId":account,"status":"not-imported"}));
    }
    let url = refs::open_url(arc_core::string(&args, "url")).ok_or("SRC_URL_INVALID")?;
    if let Some(in_flight) = jobs::jobs().in_flight(&account) {
        return Ok(in_flight);
    }
    if route == "src-containers/import" {
        let profile = arc_core::string(&args, "profile");
        if !import::profiles()
            .map_err(|e| format!("SRC_IMPORT_BLOCKED: {e}"))?
            .iter()
            .any(|p| p["directory"] == profile)
        {
            return Err("SRC_IMPORT_BLOCKED: chrome-profile-not-found".into());
        }
        let handle = app.clone();
        return Ok(jobs::jobs().start(account, store, async move {
            perform_import(&handle, args).await
        }));
    }
    main_thread(app, move |app| {
        create(app, &args, false)?;
        navigate(&account, &url)
    })
    .await
}
async fn perform_import(app: &tauri::AppHandle, args: Value) -> Result<ImportState, String> {
    let store = arc_core::string(&args, "storeId").to_owned();
    main_thread(app, move |_| check_barrier(&store)).await?;
    let profile = arc_core::string(&args, "profile").to_owned();
    let imported = tokio::task::spawn_blocking(move || {
        if !disable_core_dump() {
            return Err("core-dump-disable-failed");
        }
        import::chrome(&profile)
    })
    .await
    .map_err(|_| "import-worker-failed")?
    .map_err(str::to_owned)?;
    let known: Vec<OrgAccount> = serde_json::from_value(args["knownAccounts"].clone())
        .map_err(|_| "SRC_IMPORT_IDENTITY_INVALID")?;
    if let Some(state) = import_guard(
        arc_core::string(&args, "accountId"),
        imported.last_active_org(),
        &known,
        args["allowUnverified"] == true,
    ) {
        return Ok(state);
    }
    let installed = !imported.cookies.is_empty();
    let account = arc_core::string(&args, "accountId").to_owned();
    let url = arc_core::string(&args, "url").to_owned();
    let pending = main_thread(app, move |app| {
        create(app, &args, true)?;
        VIEWS.with(|slot| {
            let views = slot.borrow();
            let c = views
                .get(arc_core::string(&args, "accountId"))
                .ok_or("SRC_WINDOW_CLOSED")?;
            let pending = native::install(&c.view, imported).map_err(str::to_owned)?;
            IMPORTS.with(|slot| {
                slot.borrow_mut()
                    .insert(c.store_id.clone(), pending.clone())
            });
            Ok(pending)
        })
    })
    .await?;
    tokio::time::timeout(Duration::from_secs(30), async {
        while pending.load(Ordering::SeqCst) != 0 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(|_| "cookie-write-timeout")?;
    main_thread(app, move |_| navigate(&account, &url)).await?;
    Ok(ImportState::finished(Ok(installed)))
}

fn disable_core_dump() -> bool {
    unsafe extern "C" {
        fn setrlimit(resource: i32, rlim: *const [u64; 2]) -> i32;
    }
    unsafe { setrlimit(4, &[0, 0]) == 0 }
}
