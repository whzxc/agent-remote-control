//! Prepare the Desktop owner before a create receipt enters native submission.
use super::{daemon, endpoint_missing};
use crate::*;
use std::time::Duration;

const READY_TIMEOUT: Duration = Duration::from_secs(24);
const POLL: Duration = Duration::from_millis(200);

pub(crate) enum Preparation {
    Ipc,
    Backend {
        instance: daemon::Instance,
        backend: &'static str,
        reason: Option<&'static str>,
    },
    Awaiting {
        reason: &'static str,
        target: Option<daemon::Instance>,
    },
}

pub(crate) async fn prepare(
    control: &crate::control::Control,
    receipt: &Value,
) -> Result<Preparation> {
    // An independent Desktop can publish follower IPC in the common home.
    // With only managed windows alive, retain the verified backend route.
    let instances = daemon::instances().await?;
    if !instances.is_empty() && instances.iter().all(daemon::Instance::independent) {
        return independent(control).await;
    }
    match control.ipc().await {
        Ok(_) => return Ok(Preparation::Ipc),
        Err(error)
            if !endpoint_missing(&error)
                && !error.contains("DESKTOP_IPC_CONNECT_FAILED")
                && error != "DESKTOP_CONNECT_TIMEOUT" =>
        {
            return Err(error)
        }
        Err(_) => {}
    }
    let settings = crate::claude_notify::settings()?;
    let recovery = &receipt["desktopRecovery"];
    let choice = string(recovery, "choice");
    let policy = match choice {
        "restart" | "independent" => choice,
        _ => string(&settings, "desktopRecovery"),
    };
    if let Some(instance) = daemon::connected().await? {
        if super::handback::managed_instance(control, &instance).await? {
            return independent(control).await;
        }
        match control.shared_desktop_rpc().await {
            Ok(_) => {
                return Ok(Preparation::Backend {
                    instance,
                    backend: "shared",
                    reason: None,
                })
            }
            Err(_) if policy == "independent" => return independent(control).await,
            Err(error) => return Err(error),
        }
    }
    let private = crate::codex_host::socket("codex-home")?.canonicalize().ok();
    if policy == "independent"
        || private
            .as_ref()
            .is_some_and(|socket| instances.iter().any(|i| i.independent() && i.uses(socket)))
    {
        return independent(control).await;
    }
    let mut main_candidates = instances.iter().filter(|instance| {
        !instance
            .profile
            .as_deref()
            .is_some_and(daemon::is_independent_profile)
    });
    let first = main_candidates.next();
    let main = instances
        .iter()
        .find(|instance| instance.profile.is_none())
        .or_else(|| first.filter(|_| main_candidates.next().is_none()));
    let ambiguous = main.is_none() && first.is_some();
    let target = main.cloned();
    let confirmed = choice == "restart"
        && recovery["target"]
            == target
                .as_ref()
                .map(daemon::Instance::identity)
                .unwrap_or(Value::Null);

    // A private stdio Desktop has no reliable ARC-visible idle signal. Its
    // process being alive, and the absence of observed work, cannot prove idle.
    match policy {
        "restart" if ambiguous => {
            return Ok(Preparation::Awaiting {
                reason: "ambiguous-desktop",
                target,
            })
        }
        "restart" if target.is_some() && !confirmed => {
            return Ok(Preparation::Awaiting {
                reason: "activity-unconfirmed",
                target,
            })
        }
        "independent" | "restart" => {}
        _ => {
            return Ok(Preparation::Awaiting {
                reason: if ambiguous {
                    "ambiguous-desktop"
                } else {
                    "desktop-not-ready"
                },
                target,
            })
        }
    }

    daemon::start_daemon().await?;
    if let Some(instance) = ready(control).await? {
        return Ok(Preparation::Backend {
            instance,
            backend: "shared",
            reason: None,
        });
    }
    if let Some(instance) = target {
        let requested = daemon::quit(instance.clone()).await;
        if instance.running() {
            requested?;
            tokio::time::timeout(Duration::from_secs(10), async {
                while instance.running() {
                    tokio::time::sleep(POLL).await;
                }
            })
            .await
            .map_err(|_| "DESKTOP_RECOVERY_QUIT_TIMEOUT")?;
        }
        daemon::launch(instance.profile.as_deref(), &daemon::socket()?).await?;
    } else {
        daemon::launch(None, &daemon::socket()?).await?;
    }

    tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            if let Some(instance) = ready(control).await? {
                return Ok(Preparation::Backend {
                    instance,
                    backend: "shared",
                    reason: None,
                });
            }
            tokio::time::sleep(POLL).await;
        }
    })
    .await
    .map_err(|_| "DESKTOP_RECOVERY_READY_TIMEOUT")?
}

async fn ready(control: &crate::control::Control) -> Result<Option<daemon::Instance>> {
    let Some(instance) = daemon::connected().await? else {
        return Ok(None);
    };
    control.shared_desktop_rpc().await?;
    Ok(Some(instance))
}

async fn independent(control: &crate::control::Control) -> Result<Preparation> {
    let private = async {
        let rpc = control.desktop_backend_rpc(&json!("arc")).await?;
        let socket = crate::codex_host::socket("codex-home")?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if rpc.host_identity().map(|(pid, _)| pid) != Some(daemon::native_peer(&socket).await?) {
            return Err("CODEX_BACKEND_PEER_MISMATCH".to_owned());
        }
        // A cached proxy can remain open while its server is unresponsive.
        rpc.call("thread/loaded/list", json!({"limit":1}), 3000)
            .await?;
        super::handback::independent_instance(control, &socket).await
    }
    .await;
    match private {
        Ok(instance) => Ok(Preparation::Backend {
            instance,
            backend: "arc",
            reason: None,
        }),
        Err(error)
            if error == "DESKTOP_PROFILE_IN_USE" || error == "DESKTOP_RECOVERY_TARGET_CHANGED" =>
        {
            Err(error)
        }
        Err(error) => {
            control.launches.check()?;
            daemon::start_daemon().await?;
            control.shared_desktop_rpc().await?;
            let instance =
                super::handback::independent_instance(control, &daemon::socket()?).await?;
            crate::logs::record(
                "WARN",
                &format!("Independent Desktop using shared Codex backend: {error}"),
                None,
            );
            let reason = if error.contains("START_FAILED") {
                "private-start-failed"
            } else {
                "private-unreachable"
            };
            Ok(Preparation::Backend {
                instance,
                backend: "shared",
                reason: Some(reason),
            })
        }
    }
}
