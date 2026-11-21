//! Prepare the Desktop owner before a create receipt enters native submission.
use super::{daemon, endpoint_missing};
use crate::*;
use std::time::Duration;

const READY_TIMEOUT: Duration = Duration::from_secs(24);
const POLL: Duration = Duration::from_millis(200);

pub(crate) enum Preparation {
    Ipc,
    Shared(daemon::Instance),
    Awaiting {
        reason: &'static str,
        target: Option<daemon::Instance>,
    },
}

pub(crate) async fn prepare(
    control: &crate::control::Control,
    receipt: &Value,
) -> Result<Preparation> {
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
    if let Some(instance) = ready(control).await? {
        return Ok(Preparation::Shared(instance));
    }

    let settings = crate::claude_notify::settings()?;
    let recovery = &receipt["desktopRecovery"];
    let choice = string(recovery, "choice");
    let policy = match choice {
        "restart" | "independent" => choice,
        _ => string(&settings, "desktopRecovery"),
    };
    let instances = daemon::instances().await?;
    let independent = daemon::independent_profile();
    let mut main_candidates = instances
        .iter()
        .filter(|instance| instance.profile.as_deref() != Some(&independent));
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
        return Ok(Preparation::Shared(instance));
    }
    if policy == "independent" {
        if !instances
            .iter()
            .any(|instance| instance.profile.as_deref() == Some(&independent) && instance.running())
        {
            daemon::launch(Some(&independent)).await?;
        }
    } else if let Some(instance) = target {
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
        daemon::launch(instance.profile.as_deref()).await?;
    } else {
        daemon::launch(None).await?;
    }

    tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            if let Some(instance) = ready(control).await? {
                return Ok(Preparation::Shared(instance));
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
