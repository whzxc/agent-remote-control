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
                arc_core::load(&arc_core::root().join("update-status.json"))
                    .unwrap_or(json!({"phase":"idle"})),
            ),
            downloaded: Mutex::new(None),
            cancel: watch::channel(false).0,
            downloading: AtomicBool::new(false),
            installing: AtomicBool::new(false),
            restarting: AtomicBool::new(false),
        }
    }
}
fn resume_path() -> std::path::PathBuf {
    arc_core::root().join("update-resume.json")
}
pub fn pending_resume() -> bool {
    arc_core::load(&resume_path()).is_ok_and(|value| value["version"] == env!("ARC_BUILD_VERSION"))
}
pub fn take_resume() -> Option<Vec<String>> {
    let path = resume_path();
    let Ok(value) = arc_core::load(&path) else {
        return None;
    };
    // A marker from a failed/interrupted install must not alter ordinary startup.
    let resume = (value["version"] == env!("ARC_BUILD_VERSION")).then(|| {
        value["ingresses"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect()
    });
    let _ = std::fs::remove_file(path);
    resume
}
async fn updater(app: &tauri::AppHandle) -> Result<tauri_plugin_updater::Updater, String> {
    if cfg!(debug_assertions) {
        return Err("当前应用不支持自动更新，请从下载页获取安装包。".into());
    }
    let service = app
        .try_state::<std::sync::Arc<arc_core::runtime::Client>>()
        .ok_or("Core 尚未就绪")?;
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
pub async fn check_update(app: tauri::AppHandle) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let _guard = state.install.try_lock().map_err(|_| "已有更新正在进行")?;
    progress(&app, json!({"phase":"checking","error":null}));
    if let Some(service) = app.try_state::<std::sync::Arc<arc_core::runtime::Client>>() {
        let _ = service
            .request(
                "preferences",
                "PUT",
                json!({"values":{"update-last-check":chrono_now_millis()}}),
            )
            .await;
    }
    let update = match check(&app).await {
        Ok(value) => value,
        Err(error) => {
            progress(&app, json!({"phase":"idle","error":error}));
            return Err(error);
        }
    };
    let mut cached = state.downloaded.lock().await;
    if cached.as_ref().map(|(u, _)| &u.version) != update.as_ref().map(|u| &u.version) {
        *cached = None;
    }
    let result = match update {
        Some(u) => {
            json!({"available":true,"version":u.version,"notes":u.body,"date":u.date.map(|d|d.to_string()),"ready":cached.is_some()})
        }
        None => json!({"available":false}),
    };
    progress(
        &app,
        json!({"phase":"idle","update":result,"checkedAt":arc_core::now()}),
    );
    Ok(result)
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
) -> Result<Option<(tauri_plugin_updater::Update, Vec<u8>)>, String> {
    let state = app.state::<UpdateState>();
    if let Some(cached) = state.downloaded.lock().await.take() {
        if cached.0.version == version {
            return Ok(Some(cached));
        }
    }
    let state = app.state::<UpdateState>();
    let mut cancel = state.cancel.subscribe();
    state.cancel.send_replace(false);
    cancel.borrow_and_update();
    state.downloading.store(true, Ordering::SeqCst);
    let result = tokio::select! {
        result = async {
            let Some(update) = check(app).await? else {
                return Ok(None);
            };
            if update.version != version {
                return Err("可用版本已变化，请重新检查更新。".to_owned());
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
    progress(app, json!({"phase":"idle","error":result.as_ref().err()}));
    result
}
pub async fn download_update(app: tauri::AppHandle, version: String) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let _guard = state.install.try_lock().map_err(|_| "已有更新正在进行")?;
    let result = download(&app, &version).await?;
    let response = match &result {
        Some((u, _)) => json!({"available":true,"version":u.version,"notes":u.body,"ready":true}),
        None => json!({"available":false}),
    };
    *state.downloaded.lock().await = result;
    progress(&app, json!({"phase":"idle","update":response}));
    Ok(response)
}
pub async fn install_update(app: tauri::AppHandle, version: String) -> Result<Value, String> {
    let state = app.state::<UpdateState>();
    let _guard = state.install.try_lock().map_err(|_| "已有更新正在进行")?;
    let Some((update, bytes)) = download(&app, &version).await? else {
        return Ok(json!({"available":false}));
    };
    state.installing.store(true, Ordering::SeqCst);
    struct Reset<'a>(&'a UpdateState);
    impl Drop for Reset<'_> {
        fn drop(&mut self) {
            if !self.0.restarting.load(Ordering::SeqCst) {
                self.0.installing.store(false, Ordering::SeqCst);
            }
        }
    }
    let _reset = Reset(&state);
    progress(&app, json!({"phase":"installing"}));
    let service = app
        .state::<std::sync::Arc<arc_core::runtime::Client>>()
        .inner()
        .clone();
    // Download and signature verification finish before any connection is stopped.
    let current = service.request("status", "GET", json!({})).await?;
    let running: Vec<_> = current["ingresses"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|i| i["running"] == true)
        .filter_map(|i| i["id"].as_str().map(str::to_owned))
        .collect();
    arc_core::save(
        &resume_path(),
        &json!({"version":version,"ingresses":running}),
    )?;
    // Drain auxiliary work even when the tunnel is already disconnected.
    let installed = async {
        service.shutdown().await?;
        update.install(bytes).map_err(|error| error.to_string())
    }
    .await;
    if let Err(error) = installed {
        let _ = std::fs::remove_file(resume_path());
        service.resume().await;
        let restored = async {
            for id in &running {
                service
                    .request(&format!("ingress/{id}/start"), "POST", json!({}))
                    .await?;
            }
            Ok::<_, String>(json!({}))
        }
        .await;
        return Err(match restored {
            Ok(_) => format!("更新失败：{error}。可重试或手动下载。"),
            Err(restore) => format!("更新失败：{error}；恢复连接失败：{restore}"),
        });
    }
    // restart() never returns on a runtime worker. Let this command finish and
    // release its guards before the event loop completes the restart instead.
    state.restarting.store(true, Ordering::SeqCst);
    app.request_restart();
    Ok(json!({"available":true,"version":version,"restarting":true}))
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
    status["observedAt"] = json!(arc_core::now());
    let _ = arc_core::save(&arc_core::root().join("update-status.json"), &status);
    let _ = app.emit("update-progress", patch);
}

fn chrono_now_millis() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .to_string()
}
pub fn start(app: tauri::AppHandle) {
    // Persisted progress is historical; downloads and installation cannot survive this process.
    {
        let state = app.state::<UpdateState>();
        let mut status = state.status.lock().unwrap();
        if status["phase"] != "idle" {
            status["interrupted"] = json!(true);
        }
        status["phase"] = json!("idle");
        if status["update"].is_object() {
            status["update"]["ready"] = json!(false);
        }
    }
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
                if let Ok(update) = check_update(app.clone()).await {
                    if update["available"] == true && update["ready"] != true {
                        if let Some(version) = update["version"].as_str() {
                            let _ = download_update(app.clone(), version.into()).await;
                        }
                    }
                }
            }
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
        }
    });
}
