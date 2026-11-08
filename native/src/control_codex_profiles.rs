//! Merge native profile task pages while preserving each upstream cursor.
use crate::*;
const PREFIX: &str = "codex-profiles:";

impl control::Control {
    pub(crate) async fn profile_task_page(&self, args: Value) -> Result<Value> {
        let mut filter = args.clone();
        filter.as_object_mut().unwrap().remove("cursor");
        filter.as_object_mut().unwrap().remove("limit");
        let binding = hash(filter.to_string());
        let mut state = if let Some(cursor) =
            args["cursor"].as_str().and_then(|s| s.strip_prefix(PREFIX))
        {
            uuid::Uuid::parse_str(cursor).map_err(|_| "CODEX_TASK_CURSOR_INVALID")?;
            let state =
                kernel::file_cache::load(&root().join("outputs").join(format!("{cursor}.json")))
                    .map_err(|_| {
                        "CODEX_TASK_CURSOR_EXPIRED: Restart the task listing without cursor"
                    })?;
            if state["binding"] != binding {
                return Err(
                    "CODEX_TASK_CURSOR_MISMATCH: Reuse the same filters or omit cursor".into(),
                );
            }
            state
        } else {
            let profiles = accounts::codex::profiles()?
                .into_iter()
                .filter(|p| {
                    accounts::codex::home(&p.id)
                        .ok()
                        .is_some_and(|h| h.join("sessions").exists())
                })
                .collect::<Vec<_>>();
            if profiles.is_empty() || args["cursor"].is_string() {
                let mut page = self.request("thread/list", args, 60000).await?;
                if let Ok(account) = accounts::profile_account("codex-home") {
                    for row in page["data"].as_array_mut().into_iter().flatten() {
                        row["agentAccountId"] = account["id"].clone();
                    }
                }
                return Ok(page);
            }
            let mut sources =
                vec![json!({"profileId":"codex-home","rows":[],"cursor":null,"done":false})];
            sources.extend(
                profiles
                    .iter()
                    .map(|p| json!({"profileId":p.id,"rows":[],"cursor":null,"done":false})),
            );
            json!({"binding":binding,"sources":sources})
        };
        let limit = num(&args, "limit", 20).clamp(1, 100);
        let sort_key = if args["sortKey"] == "created_at" {
            "createdAt"
        } else {
            "updatedAt"
        };
        let mut data = vec![];
        while data.len() < limit {
            for source in state["sources"]
                .as_array_mut()
                .ok_or("CODEX_TASK_CURSOR_INVALID")?
            {
                if source["done"] == true || !source["rows"].as_array().unwrap().is_empty() {
                    continue;
                }
                let mut params = args.clone();
                params["cursor"] = source["cursor"].clone();
                params["limit"] = json!(limit);
                let page = self
                    .profile_rpc(string(source, "profileId"))
                    .await?
                    .call("thread/list", params, 60000)
                    .await?;
                source["rows"] = page["data"].clone();
                if !source["rows"].is_array() {
                    return Err("NATIVE_TASKS_MISSING".into());
                }
                source["cursor"] = page["nextCursor"].clone();
                source["done"] = json!(page["nextCursor"].is_null());
            }
            let sources = state["sources"].as_array_mut().unwrap();
            let next = sources
                .iter()
                .enumerate()
                .filter_map(|(i, s)| s["rows"].as_array()?.first().map(|row| (i, row)))
                .max_by(|(_, a), (_, b)| {
                    let order = a[sort_key]
                        .as_i64()
                        .cmp(&b[sort_key].as_i64())
                        .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()));
                    if args["sortDirection"] == "asc" {
                        order.reverse()
                    } else {
                        order
                    }
                })
                .map(|(i, _)| i);
            let Some(next) = next else {
                break;
            };
            let source = &mut sources[next];
            let mut row = source["rows"].as_array_mut().unwrap().remove(0);
            accounts::codex::observe_thread(string(source, "profileId"), string(&row, "id"))?;
            if let Ok(account) = accounts::profile_account(string(source, "profileId")) {
                row["agentAccountId"] = account["id"].clone();
            }
            data.push(row);
        }
        let more = state["sources"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["done"] != true || !s["rows"].as_array().unwrap().is_empty());
        let cursor = if more {
            let id = id();
            save(&root().join("outputs").join(format!("{id}.json")), &state)?;
            Some(format!("{PREFIX}{id}"))
        } else {
            None
        };
        Ok(json!({"data":data,"nextCursor":cursor,"metadataSource":"native-profiles"}))
    }
}
