use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;
use tokio::sync::{watch, Mutex};

pub struct UpdateState {
    install: Mutex<()>,
    status: std::sync::Mutex<Value>,
    downloaded: Mutex<Option<(tauri_plugin_updater::Update, Vec<u8>)>>,
    cancel: watch::Sender<bool>,
    downloading: AtomicBool,
    pub installing: AtomicBool,
    pub restarting: AtomicBool,
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            install: Mutex::new(()),
            status: std::sync::Mutex::new(
                json!({"phase":"idle","revision":0,"update":null,"error":null,"errorStage":null,"downloaded":0,"total":null,"checkedAt":null}),
            ),
            downloaded: Mutex::new(None),
            cancel: watch::channel(false).0,
            downloading: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
        }
    }
}
async fn updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if app.config().identifier != "com.whzxc.agent-remote-control" {
        return Err("This app does not support automatic updates. Get the installer from the download page.".into());
    }
    let service = app
        .try_state::<std::sync::Arc<arc_core::runtime::Client>>()
        .ok_or("Core is not ready")?;
    let proxy = service.network_proxy().await?;
    app.updater_builder()
        .configure_client(move |builder| proxy.client(builder))
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}
async fn check(app: &tauri::AppHandle) -> Result<Option<tauri_plugin_updater::Update>, String> {
    match updater(app).await?.check().await {
        Ok(update) => Ok(update),
        Err(
            tauri_plugin_updater::Error::TargetNotFound(_)
            | tauri_plugin_updater::Error::TargetsNotFound(_),
        ) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}
fn update_result(update: &tauri_plugin_updater::Update, ready: bool) -> Value {
    json!({"available":true,"version":update.version,"notes":update.body,"date":update.date.map(|d|d.to_string()),"ready":ready})
}
fn current_result(app: &tauri::AppHandle) -> Result<Value, String> {
    let status = snapshot(app);
    if let Some(error) = status["error"].as_str() {
        return Err(error.into());
    }
    Ok(status
        .get("update")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or(json!({"available":false})))
}
fn failed(app: &tauri::AppHandle, stage: &str, error: String) -> String {
    let mut status = json!({"phase":"idle","error":error,"errorStage":stage});
    if stage == "check" {
        status["checkedAt"] = json!(arc_core::now());
    }
    progress(app, status);
    error
}

pub async fn check_update(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let observed = snapshot(&app)["revision"].clone();
    let _guard = state.install.lock().await;
    // Join the operation that owned the lock instead of reporting a busy error
    // or checking again between an automatic check and its download.
    if snapshot(&app)["revision"] != observed {
        return current_result(&app);
    }
    progress(
        &app,
        json!({"phase":"checking","update":null,"error":null,"errorStage":null,"downloaded":0,"total":null}),
    );
    if let Some(service) = app.try_state::<std::sync::Arc<arc_core::runtime::Client>>() {
        let _ = service
            .request(
                "preferences",
                "PUT",
                json!({"values":{"update-last-check":chrono_now_millis()}}),
            )
            .await;
    }
    let update = check(&app)
        .await
        .map_err(|error| failed(&app, "check", error))?;
    progress(&app, json!({"checkedAt":arc_core::now()}));
    let mut cached = state.downloaded.lock().await;
    if cached.as_ref().map(|(u, _)| &u.version) != update.as_ref().map(|u| &u.version) {
        *cached = None;
    }
    if let Some((update, _)) = cached.as_ref() {
        let result = update_result(update, true);
        progress(&app, json!({"phase":"idle","update":result}));
        return Ok(result);
    }
    drop(cached);
    let Some(update) = update else {
        let result = json!({"available":false});
        progress(&app, json!({"phase":"idle","update":result}));
        return Ok(result);
    };
    let version = update.version.clone();
    let downloaded = download(&app, &version, Some(update))
        .await
        .map_err(|error| failed(&app, "download", error))?;
    complete_download(&app, downloaded).await
}
pub fn cancel_update(app: tauri::AppHandle) {
    let state = app.state::<UpdateState>();
    if state.downloading.load(Ordering::SeqCst) {
        state.cancel.send_replace(true);
    }
}
async fn download(
    app: &tauri::AppHandle,
    version: &str,
    known: Option<tauri_plugin_updater::Update>,
) -> Result<Option<(tauri_plugin_updater::Update, Vec<u8>)>, String> {
    let state = app.state::<UpdateState>();
    if let Some(cached) = state.downloaded.lock().await.take() {
        if cached.0.version == version {
            return Ok(Some(cached));
        }
    }
    let mut cancel = state.cancel.subscribe();
    state.cancel.send_replace(false);
    cancel.borrow_and_update();
    state.downloading.store(true, Ordering::SeqCst);
    let offer = known
        .as_ref()
        .map(|update| update_result(update, false))
        .unwrap_or_else(|| snapshot(app)["update"].clone());
    progress(
        app,
        json!({"phase":"downloading","update":offer,"error":null,"errorStage":null,"downloaded":0,"total":null}),
    );
    let result = tokio::select! {
        result = async {
            let Some(update) = (match known { Some(update) => Some(update), None => check(app).await? }) else {
                return Ok(None);
            };
            if update.version != version {
                progress(app, json!({"update":null}));
                return Err("The available version changed. Check for updates again.".to_owned());
            }
            let mut downloaded = 0usize;
            let bytes = update.download(|chunk, total| {
                downloaded += chunk;
                progress(app, json!({"downloaded":downloaded,"total":total,"phase":"downloading"}));
            }, || {}).await.map_err(|e|e.to_string())?;
            Ok(Some((update, bytes)))
        } => result,
        _ = cancel.changed() => Err("UPDATE_CANCELLED".into()),
    };
    state.downloading.store(false, Ordering::SeqCst);
    result
}
async fn complete_download(
    app: &tauri::AppHandle,
    downloaded: Option<(tauri_plugin_updater::Update, Vec<u8>)>,
) -> Result<Value, String> {
    let response = downloaded
        .as_ref()
        .map(|(u, _)| update_result(u, true))
        .unwrap_or(json!({"available":false}));
    *app.state::<UpdateState>().downloaded.lock().await = downloaded;
    progress(
        app,
        json!({"phase":"idle","update":response,"error":null,"errorStage":null}),
    );
    Ok(response)
}
pub async fn download_update(app: tauri::AppHandle, version: String) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let _guard = state.install.lock().await;
    if state.installing.load(Ordering::SeqCst) {
        return Ok(json!({"available":true,"version":version,"restarting":true}));
    }
    let downloaded = download(&app, &version, None)
        .await
        .map_err(|error| failed(&app, "download", error))?;
    complete_download(&app, downloaded).await
}
pub async fn install_update(app: tauri::AppHandle, version: String) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let _guard = state.install.lock().await;
    if state.installing.load(Ordering::SeqCst) {
        return Ok(json!({"version":version,"restarting":true}));
    }
    let candidate = state.downloaded.lock().await.take();
    let Some((update, bytes)) = candidate else {
        return Err("Download the update before installing it.".into());
    };
    if update.version != version {
        *state.downloaded.lock().await = Some((update, bytes));
        return Err("The available version changed. Check for updates again.".into());
    }
    state.installing.store(true, Ordering::SeqCst);
    progress(
        &app,
        json!({"phase":"installing","error":null,"errorStage":null}),
    );
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let service = handle
            .state::<std::sync::Arc<arc_core::runtime::Client>>()
            .inner()
            .clone();
        let install = async {
            if let Err(error) = service.shutdown().await {
                *handle.state::<UpdateState>().downloaded.lock().await = Some((update, bytes));
                return Err(error);
            }
            let result = tokio::task::spawn_blocking(move || {
                let result = update.install(&bytes).map_err(|error| error.to_string());
                (update, bytes, result)
            })
            .await
            .map_err(|error| error.to_string())?;
            let (update, bytes, result) = result;
            if let Err(error) = result {
                *handle.state::<UpdateState>().downloaded.lock().await = Some((update, bytes));
                return Err(error);
            }
            Ok::<_, String>(())
        }
        .await;
        match install {
            Ok(()) => {
                handle
                    .state::<UpdateState>()
                    .restarting
                    .store(true, Ordering::SeqCst);
                handle.request_restart();
            }
            Err(error) => {
                service.resume().await;
                handle
                    .state::<UpdateState>()
                    .installing
                    .store(false, Ordering::SeqCst);
                failed(&handle, "install", error);
            }
        }
    });
    Ok(json!({"version":version,"restarting":true}))
}

pub fn snapshot(app: &tauri::AppHandle) -> Value {
    app.state::<UpdateState>().status.lock().unwrap().clone()
}
fn progress(app: &tauri::AppHandle, patch: Value) {
    let state = app.state::<UpdateState>();
    let mut status = state.status.lock().unwrap();
    for (k, v) in patch.as_object().unwrap() {
        status[k] = v.clone();
    }
    status["revision"] = json!(status["revision"].as_u64().unwrap_or(0) + 1);
    status["observedAt"] = json!(arc_core::now());
    let _ = app.emit("update-progress", status.clone());
}

fn chrono_now_millis() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
pub fn start(app: tauri::AppHandle) {
    // Old progress files cannot represent this process's update or byte cache.
    let _ = std::fs::remove_file(arc_core::root().join("update-status.json"));
    progress(&app, json!({"phase":"idle"}));
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        loop {
            let prefs = arc_core::preferences::read();
            let previous = prefs["update-last-check"]
                .as_str()
                .unwrap_or("0")
                .parse::<u128>()
                .unwrap_or(0);
            let current = chrono_now_millis().parse::<u128>().unwrap_or(0);
            if current.saturating_sub(previous) >= 3600000 {
                let _ = check_update(app.clone()).await;
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
