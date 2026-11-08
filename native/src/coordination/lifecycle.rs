//! Authenticated local tooling observations, never exposed as a control-source op.
use super::*;
use serde::Deserialize;
// Opaque command capabilities are issued from authenticated Core context. The
// handoff may retain the token, but cannot choose a source identity itself.
static COMMAND_ORIGINS: std::sync::LazyLock<
    std::sync::Mutex<std::collections::VecDeque<(String, String)>>,
> = std::sync::LazyLock::new(|| std::sync::Mutex::new(std::collections::VecDeque::new()));

pub(crate) fn command_environment(params: &mut Value, origin: &Value) {
    let source = string(origin, "sourceId");
    let token = if source.is_empty() {
        String::new()
    } else {
        let mut origins = COMMAND_ORIGINS.lock().unwrap();
        if let Some((token, _)) = origins.iter().find(|(_, owner)| owner == source) {
            token.clone()
        } else {
            let token = id();
            if origins.len() >= 256 {
                origins.pop_front();
            }
            origins.push_back((token.clone(), source.into()));
            token
        }
    };
    if !params["env"].is_object() {
        params["env"] = json!({});
    }
    params["env"]["ARC_TOOLING_ORIGIN"] = json!(token);
    params["env"]["ARC_STATE_DIR"] = json!(root());
}

pub(crate) fn command_source(body: &Value) -> Option<String> {
    let token = body["toolingOrigin"].as_str()?;
    COMMAND_ORIGINS
        .lock()
        .unwrap()
        .iter()
        .find(|(issued, _)| issued == token)
        .map(|(_, source)| source.clone())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    transition_id: String,
    kind: EventKind,
    repository: String,
    lane: Option<String>,
    instance: Option<String>,
    pid: Option<u32>,
    exit_code: Option<i32>,
    #[serde(rename = "toolingOrigin")]
    _tooling_origin: Option<String>,
}
pub(crate) fn alive(pid: u32) -> Result<bool> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err("INVALID_ARGUMENT: process ID".into());
    }
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as i32, 0) };
        if result == 0 {
            return Ok(true);
        }
        match std::io::Error::last_os_error().raw_os_error() {
            Some(libc::ESRCH) => Ok(false),
            _ => Err("COVERAGE_GAP: process identity unavailable".into()),
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return if GetLastError() == ERROR_INVALID_PARAMETER {
                    Ok(false)
                } else {
                    Err("COVERAGE_GAP: process identity unavailable".into())
                };
            }
            let mut code = 0;
            let result = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            if result == 0 {
                Err("COVERAGE_GAP: process identity unavailable".into())
            } else {
                Ok(code == 259)
            }
        }
    }
}
pub(crate) fn read(id: &str) -> Result<Value> {
    types::identifier(id)?;
    let row = load(
        &root()
            .join("coordination/tooling")
            .join(format!("{id}.json")),
    )?;
    observers::project(
        &root()
            .join("coordination/tooling")
            .join(format!("{id}.json")),
        super::emit,
    )?;
    let resources: Vec<ResourceKey> =
        serde_json::from_value(row["coordinationPending"][0]["resources"].clone())
            .map_err(|_| "COORDINATION_STORAGE: invalid lifecycle resources")?;
    let mut result =
        super::bulletin::warnings_for_source(&resources, row["initiatingSource"].as_str());
    result["transitionId"] = json!(id);
    result["state"] = json!("observed");
    result["kind"] = row["coordinationPending"][0]["kind"].clone();
    result["coverage"] = json!("readback-confirmed");
    Ok(result)
}
pub(crate) async fn report(c: &crate::control::Control, body: Value) -> Result<Value> {
    let report: Report = serde_json::from_value(body.clone())
        .map_err(|_| "INVALID_ARGUMENT: read coordination.observe local schema")?;
    types::identifier(&report.transition_id)?;
    let file = root()
        .join("coordination/tooling")
        .join(format!("{}.json", report.transition_id));
    let digest = hash(body.to_string());
    if file.exists() {
        if load(&file)?["digest"] != digest {
            return Err(
                "COORDINATION_TRANSITION_CONFLICT: retain the original tooling report".into(),
            );
        }
        return read(&report.transition_id);
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        // One reporting validation can overlap the single Git watcher. A timed-out
        // filesystem probe retains its admission permit until the OS call returns.
        static ADMISSION: std::sync::LazyLock<Arc<tokio::sync::Semaphore>> =
            std::sync::LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(1)));
        let permit = ADMISSION
            .clone()
            .try_acquire_owned()
            .map_err(|_| "COVERAGE_GAP: local observation busy; retry the same transition")?;
        let projects = crate::projects::catalog(c).await?;
        let requested = report.repository.clone();
        let (project, refs, _permit) = tokio::task::spawn_blocking(move || -> Result<_> {
            let repository = Path::new(&requested)
                .canonicalize()
                .map_err(|_| "COVERAGE_GAP: repository unavailable")?;
            let matches: Vec<_> = projects
                .iter()
                .filter(|p| {
                    p["roots"].as_array().into_iter().flatten().any(|r| {
                        Path::new(string(r, "path"))
                            .canonicalize()
                            .is_ok_and(|p| p == repository)
                    })
                })
                .collect();
            if matches.len() != 1 {
                return Err(
                    "COVERAGE_GAP: tooling repository needs one registered parent project".into(),
                );
            }
            let project = string(matches[0], "id").to_owned();
            let mut reader = super::git_watch::RefReader::default();
            let common = reader.common(&repository)?;
            let refs = reader.refs(&common)?;
            Ok((project, refs, permit))
        })
        .await
        .map_err(|_| "COVERAGE_GAP: filesystem observation unavailable")??;
        let project = project.as_str();
        let mut resources = vec![ResourceKey::project(project)?];
        match report.kind {
            EventKind::LaneCreated | EventKind::LaneLanded | EventKind::LaneRemoved => {
                let lane = report
                    .lane
                    .as_deref()
                    .ok_or("INVALID_ARGUMENT: lane required")?;
                resources.push(ResourceKey::lane(project, lane)?);
                let branch = format!("refs/heads/wt/{lane}");
                let worktrees = crate::projects::git(
                    &report.repository,
                    vec!["worktree".into(), "list".into(), "--porcelain".into()],
                )
                .await?;
                let present = worktrees.lines().any(|l| l == format!("branch {branch}"));
                match report.kind {
                    EventKind::LaneCreated if !present || !refs.contains_key(&branch) => {
                        return Err("COVERAGE_GAP: lane creation readback failed".into())
                    }
                    EventKind::LaneRemoved if present || refs.contains_key(&branch) => {
                        return Err("COVERAGE_GAP: lane removal readback failed".into())
                    }
                    EventKind::LaneLanded => {
                        let lane = refs.get(&branch).ok_or("COVERAGE_GAP: lane ref missing")?;
                        let main = refs
                            .get("refs/heads/main")
                            .ok_or("COVERAGE_GAP: main ref missing")?;
                        crate::projects::git(
                            &report.repository,
                            vec![
                                "merge-base".into(),
                                "--is-ancestor".into(),
                                lane.clone(),
                                main.clone(),
                            ],
                        )
                        .await
                        .map_err(|_| "COVERAGE_GAP: land ancestry unavailable")?;
                    }
                    _ => {}
                }
            }
            EventKind::IsolatedStarted | EventKind::IsolatedExited => {
                let instance = types::identifier(
                    report
                        .instance
                        .as_deref()
                        .ok_or("INVALID_ARGUMENT: instance required")?,
                )?;
                resources.push(ResourceKey::parse(&format!("isolated:{instance}"))?);
                let running = alive(report.pid.ok_or("INVALID_ARGUMENT: pid required")?)?;
                if running != matches!(report.kind, EventKind::IsolatedStarted) {
                    return Err("COVERAGE_GAP: process lifecycle readback disagrees".into());
                }
                if matches!(report.kind, EventKind::IsolatedExited) && report.exit_code.is_none() {
                    return Err("COVERAGE_GAP: exit code unavailable".into());
                }
            }
            _ => {
                return Err(
                    "INVALID_ARGUMENT: only lane and isolated lifecycle observations are supported"
                        .into(),
                )
            }
        }
        let mut input = EventInput::new(report.transition_id.clone(), report.kind, resources);
        input.origin = Some(Principal::LocalAuthority);
        input.status = Some(if input.kind == EventKind::IsolatedStarted {
            EventStatus::Running
        } else if report.exit_code.is_some_and(|code| code != 0) {
            EventStatus::Failed
        } else {
            EventStatus::Succeeded
        });
        {
            static WRITER: std::sync::Mutex<()> = std::sync::Mutex::new(());
            let _writer = WRITER.lock().unwrap();
            if file.exists() {
                if load(&file)?["digest"] != digest {
                    return Err(
                        "COORDINATION_TRANSITION_CONFLICT: retain the original tooling report"
                            .into(),
                    );
                }
            } else {
                observers::durable(
                    &file,
                    &json!({"digest":digest,"initiatingSource":command_source(&body),"coordinationPending":[input]}),
                )?;
            }
        }
        read(&report.transition_id)
    })
    .await;
    result.unwrap_or_else(|_|Err("COVERAGE_GAP: local reporting deadline exceeded; original tooling operation is unaffected".into()))
}
