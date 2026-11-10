//! Source authority stays in Core. Ingress authentication never caches or copies it.
pub(crate) use crate::sources::require_control_source;
use crate::*;
pub(crate) async fn begin_switch(source_id: &str, entry: &Value) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::begin_switch(source_id, entry).await;
    }
    crate::front_door::process::authority(
        "begin_switch",
        json!({"source_id":source_id,"entry":entry}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn cancel_switch(source_id: &str) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::cancel_switch(source_id).await;
    }
    crate::front_door::process::authority("cancel_switch", json!({"source_id":source_id}))
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn candidates(source: &Value, grants: &[String]) -> Result<Vec<Value>> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::candidates(source, grants);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "candidates",
            json!({"source":source,"grants":grants}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn connect(
    ingress: &str,
    grant: &str,
    target: &str,
    grants: &[String],
) -> Result<Option<String>> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::connect(ingress, grant, target, grants).await;
    }
    crate::front_door::process::authority(
        "connect",
        json!({"ingress":ingress,"grant":grant,"target":target,"grants":grants}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn connection_state(ingress: &str, connected: bool) -> Result<()> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::connection_state(ingress, connected).await;
    }
    crate::front_door::process::authority(
        "connection_state",
        json!({"ingress":ingress,"connected":connected}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn control_sources() -> Result<Vec<Value>> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::control_sources();
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "control_sources",
            json!({}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn disconnect(id: &str) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::disconnect(id).await;
    }
    crate::front_door::process::authority("disconnect", json!({"id":id}))
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn ensure_ingress(entry: &Value) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::ensure_ingress(entry).await;
    }
    crate::front_door::process::authority("ensure_ingress", json!({"entry":entry}))
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn for_grant(ingress: &str, grant: &str) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::for_grant(ingress, grant);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "for_grant",
            json!({"ingress":ingress,"grant":grant}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn get(id: &str) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::get(id);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "get",
            json!({"id":id}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn grant_active(ingress: &str, grant: &str) -> bool {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::grant_active(ingress, grant);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "grant_active",
            json!({"ingress":ingress,"grant":grant}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
    .unwrap_or(false)
}
pub(crate) async fn pending(entry: &Value, grant: &str, client: &str, name: &str) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::pending(entry, grant, client, name).await;
    }
    crate::front_door::process::authority(
        "pending",
        json!({"entry":entry,"grant":grant,"client":client,"name":name}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn remove_connection(entry: &Value, pending: Vec<String>) -> Result<()> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::remove_connection(entry, pending).await;
    }
    crate::front_door::process::authority(
        "remove_connection",
        json!({"entry":entry,"pending":pending}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn revoke_grants(ingress: &str, grants: &[String]) -> Result<()> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::revoke_grants(ingress, grants).await;
    }
    crate::front_door::process::authority(
        "revoke_grants",
        json!({"ingress":ingress,"grants":grants}),
    )
    .await
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn update(id: &str, body: &Value) -> Result<Value> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::update(id, body).await;
    }
    crate::front_door::process::authority("update", json!({"id":id,"body":body}))
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) fn validate_claim(pending: &Value, target: &str, grants: &[String]) -> Result<()> {
    if !crate::front_door::process::is_front_door() {
        return crate::sources::validate_claim(pending, target, grants);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(crate::front_door::process::authority(
            "validate_claim",
            json!({"pending":pending,"target":target,"grants":grants}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
pub(crate) async fn handle(op: &str, body: Value) -> Result<Value> {
    match op {
        "active_grants" => {
            let ingress = string(&body, "ingress");
            let grants: Vec<String> =
                serde_json::from_value(body["grants"].clone()).map_err(|e| e.to_string())?;
            Ok(json!(grants
                .into_iter()
                .filter(|grant| crate::sources::grant_active(ingress, grant))
                .collect::<Vec<_>>()))
        }
        "default_policy" => Ok(crate::kernel::policy::default_policy()),
        "ingress_retired" => Ok(json!(crate::sources::ingress_retired(string(
            &body, "ingress"
        )))),
        "begin_switch" => serde_json::to_value(
            crate::sources::begin_switch(string(&body, "source_id"), &body["entry"]).await?,
        )
        .map_err(|e| e.to_string()),
        "cancel_switch" => {
            serde_json::to_value(crate::sources::cancel_switch(string(&body, "source_id")).await?)
                .map_err(|e| e.to_string())
        }
        "candidates" => serde_json::to_value(crate::sources::candidates(
            &body["source"],
            &serde_json::from_value::<Vec<String>>(body["grants"].clone())
                .map_err(|e| e.to_string())?,
        )?)
        .map_err(|e| e.to_string()),
        "connect" => serde_json::to_value(
            crate::sources::connect(
                string(&body, "ingress"),
                string(&body, "grant"),
                string(&body, "target"),
                &serde_json::from_value::<Vec<String>>(body["grants"].clone())
                    .map_err(|e| e.to_string())?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "connection_state" => serde_json::to_value(
            crate::sources::connection_state(
                string(&body, "ingress"),
                body["connected"]
                    .as_bool()
                    .ok_or("invalid authority argument")?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "control_sources" => {
            serde_json::to_value(crate::sources::control_sources()?).map_err(|e| e.to_string())
        }
        "disconnect" => {
            serde_json::to_value(crate::sources::disconnect(string(&body, "id")).await?)
                .map_err(|e| e.to_string())
        }
        "ensure_ingress" => {
            serde_json::to_value(crate::sources::ensure_ingress(&body["entry"]).await?)
                .map_err(|e| e.to_string())
        }
        "for_grant" => serde_json::to_value(crate::sources::for_grant(
            string(&body, "ingress"),
            string(&body, "grant"),
        )?)
        .map_err(|e| e.to_string()),
        "get" => serde_json::to_value(crate::sources::get(string(&body, "id"))?)
            .map_err(|e| e.to_string()),
        "grant_active" => serde_json::to_value(crate::sources::grant_active(
            string(&body, "ingress"),
            string(&body, "grant"),
        ))
        .map_err(|e| e.to_string()),
        "pending" => serde_json::to_value(
            crate::sources::pending(
                &body["entry"],
                string(&body, "grant"),
                string(&body, "client"),
                string(&body, "name"),
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "remove_connection" => serde_json::to_value(
            crate::sources::remove_connection(
                &body["entry"],
                serde_json::from_value(body["pending"].clone()).map_err(|e| e.to_string())?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "revoke_grants" => serde_json::to_value(
            crate::sources::revoke_grants(
                string(&body, "ingress"),
                &serde_json::from_value::<Vec<String>>(body["grants"].clone())
                    .map_err(|e| e.to_string())?,
            )
            .await?,
        )
        .map_err(|e| e.to_string()),
        "update" => {
            serde_json::to_value(crate::sources::update(string(&body, "id"), &body["body"]).await?)
                .map_err(|e| e.to_string())
        }
        "validate_claim" => serde_json::to_value(crate::sources::validate_claim(
            &body["pending"],
            string(&body, "target"),
            &serde_json::from_value::<Vec<String>>(body["grants"].clone())
                .map_err(|e| e.to_string())?,
        )?)
        .map_err(|e| e.to_string()),
        _ => Err("FRONT_DOOR_AUTHORITY_OPERATION: Use a matching front-door protocol.".into()),
    }
}

pub(crate) fn ingress_retired(ingress: &str) -> bool {
    if !super::process::is_front_door() {
        return crate::sources::ingress_retired(ingress);
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current().block_on(super::process::authority(
            "ingress_retired",
            json!({"ingress":ingress}),
        ))
    })
    .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
    .unwrap_or(true)
}

pub(crate) fn default_policy() -> Result<Value> {
    if !super::process::is_front_door() {
        return Ok(crate::kernel::policy::default_policy());
    }
    tokio::task::block_in_place(|| {
        tokio::runtime::Handle::current()
            .block_on(super::process::authority("default_policy", json!({})))
    })
}

pub(crate) async fn active_grants(ingress: &str, grants: Vec<String>) -> Result<Vec<String>> {
    if !super::process::is_front_door() {
        return Ok(grants
            .into_iter()
            .filter(|grant| crate::sources::grant_active(ingress, grant))
            .collect());
    }
    super::process::authority("active_grants", json!({"ingress":ingress,"grants":grants}))
        .await
        .and_then(|v| serde_json::from_value(v).map_err(|e| e.to_string()))
}
