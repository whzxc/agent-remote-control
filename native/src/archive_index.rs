//! Read-only archived metadata from the native Codex SQLite index. No rollout scan or writer acquisition.
use crate::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rusqlite::{Connection, OpenFlags};
use std::collections::HashSet;
const PREFIX: &str = "archive-index:";

pub(crate) fn list(args: &Value) -> Result<Option<Value>> {
    let home = crate::accounts::codex::default_home()?;
    let path = std::fs::read_dir(home)
        .ok()
        .into_iter()
        .flatten()
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name().to_str()?.to_owned();
            let version = name
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?
                .parse::<u32>()
                .ok()?;
            Some((version, entry.path()))
        })
        .max_by_key(|(version, _)| *version)
        .map(|(_, path)| path);
    let result = (|| {
        let Some(path) = path else {
            return Ok(None);
        };
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;
        db.busy_timeout(std::time::Duration::from_millis(100))
            .map_err(|e| e.to_string())?;
        list_connection(&db, args).map(Some)
    })();
    match result {
        Ok(page) => Ok(page),
        Err(error) if error.starts_with("ARCHIVE_CURSOR_") => Err(error),
        Err(_) if string(args, "cursor").starts_with(PREFIX) => {
            Err("ARCHIVE_INDEX_UNAVAILABLE: omit cursor to restart using the native listing".into())
        }
        Err(_) => Ok(None), // An absent or changed upstream index uses the native API.
    }
}
/// Native-index adapter; callers may use an in-memory native-schema database for regression checks.
pub fn list_connection(db: &Connection, args: &Value) -> Result<Value> {
    let columns: HashSet<String> = db
        .prepare("PRAGMA table_info(threads)")
        .map_err(|e| e.to_string())?
        .query_map([], |r| r.get(1))
        .map_err(|e| e.to_string())?
        .collect::<std::result::Result<_, _>>()
        .map_err(|e| e.to_string())?;
    if [
        "id",
        "archived",
        "updated_at",
        "cwd",
        "title",
        "source",
        "model_provider",
    ]
    .iter()
    .any(|c| !columns.contains(*c))
    {
        return Err("ARCHIVE_INDEX_SCHEMA_UNSUPPORTED".into());
    }
    let optional = |column: &str| {
        if columns.contains(column) {
            format!("COALESCE({column},'')")
        } else {
            "''".into()
        }
    };
    let updated = if columns.contains("updated_at_ms") {
        "COALESCE(updated_at_ms,updated_at*1000)"
    } else {
        "updated_at*1000"
    };
    let title = if columns.contains("name") {
        "COALESCE(NULLIF(name,''),title)"
    } else {
        "title"
    };
    let preview = optional("preview");
    let first = optional("first_user_message");
    let search = string(args, "searchTerm");
    let cwd = args["cwd"][0].as_str().unwrap_or("");
    let binding = hash(json!([search, cwd]).to_string());
    let mut before: Option<i64> = None;
    let mut before_id = String::new();
    if let Some(cursor) = args["cursor"].as_str() {
        let encoded = cursor
            .strip_prefix(PREFIX)
            .ok_or("ARCHIVE_CURSOR_MISMATCH: omit cursor when switching native/index listing")?;
        let bytes = URL_SAFE_NO_PAD
            .decode(encoded)
            .map_err(|_| "ARCHIVE_CURSOR_INVALID")?;
        let cursor: Value = serde_json::from_slice(&bytes).map_err(|_| "ARCHIVE_CURSOR_INVALID")?;
        if cursor["binding"] != binding {
            return Err("ARCHIVE_CURSOR_MISMATCH: reuse searchTerm/project or omit cursor".into());
        }
        before = Some(cursor["updated"].as_i64().ok_or("ARCHIVE_CURSOR_INVALID")?);
        before_id = cursor["id"]
            .as_str()
            .ok_or("ARCHIVE_CURSOR_INVALID")?
            .into();
    }
    let limit = num(args, "limit", 20).clamp(1, 100);
    let sql=format!("SELECT id,{title},{preview},cwd,{updated},model_provider,{},{} FROM threads WHERE archived=1 AND source NOT LIKE '%subagent%' AND (?1='' OR instr(lower({title} || ' ' || {preview} || ' ' || {first}),lower(?1))>0) AND (?2='' OR cwd=?2) AND (?3 IS NULL OR {updated} < ?3 OR ({updated}=?3 AND id<?4)) ORDER BY {updated} DESC,id DESC LIMIT ?5",optional("model"),optional("reasoning_effort"));
    let rows=db.prepare(&sql).map_err(|e|e.to_string())?.query_map(rusqlite::params![search,cwd,before,before_id,(limit+1) as i64],|row| {
        Ok(json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"preview":row.get::<_,String>(2)?,"cwd":row.get::<_,String>(3)?,"updatedAt":row.get::<_,i64>(4)?/1000,"indexUpdatedMs":row.get::<_,i64>(4)?,"modelProvider":row.get::<_,String>(5)?,"model":row.get::<_,String>(6)?,"reasoningEffort":row.get::<_,String>(7)?}))
    }).map_err(|e|e.to_string())?.collect::<std::result::Result<Vec<_>,_>>().map_err(|e|e.to_string())?;
    let next = if rows.len() > limit {
        let last = &rows[limit - 1];
        Some(format!(
            "{PREFIX}{}",
            URL_SAFE_NO_PAD.encode(
                json!({"binding":binding,"updated":last["indexUpdatedMs"],"id":last["id"]})
                    .to_string()
            )
        ))
    } else {
        None
    };
    let data: Vec<_> = rows
        .into_iter()
        .take(limit)
        .map(|mut row| {
            row.as_object_mut().unwrap().remove("indexUpdatedMs");
            row
        })
        .collect();
    Ok(json!({"data":data,"nextCursor":next,"metadataSource":"native-sqlite-index"}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn indexed_search_is_fast_fresh_and_paginates_without_duplicates() {
        // Regression: archived searches skipped enrichment but still took 7-30 seconds in native thread/list.
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,archived INTEGER,updated_at INTEGER,cwd TEXT,title TEXT,source TEXT,model_provider TEXT); CREATE INDEX archive ON threads(archived,updated_at DESC,id DESC);").unwrap();
        let transaction = db.transaction().unwrap();
        for i in 0..6000 {
            transaction
                .execute(
                    "INSERT INTO threads VALUES(?1,1,?2,'/project','Search needle','cli','native')",
                    rusqlite::params![format!("id-{i:05}"), i / 2],
                )
                .unwrap();
        }
        transaction.commit().unwrap();
        let start = std::time::Instant::now();
        let first = list_connection(&db, &json!({"searchTerm":"NEEDLE","limit":20})).unwrap();
        assert!(start.elapsed() < std::time::Duration::from_secs(1));
        assert_eq!(first["data"].as_array().unwrap().len(), 20);
        let second = list_connection(
            &db,
            &json!({"searchTerm":"NEEDLE","limit":20,"cursor":first["nextCursor"]}),
        )
        .unwrap();
        assert!(second["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|b| first["data"]
                .as_array()
                .unwrap()
                .iter()
                .all(|a| a["id"] != b["id"])));
        assert!(list_connection(
            &db,
            &json!({"searchTerm":"different","cursor":first["nextCursor"]})
        )
        .is_err());
        db.execute(
            "INSERT INTO threads VALUES('new',1,9999,'/project','Fresh needle','cli','native')",
            [],
        )
        .unwrap();
        assert_eq!(
            list_connection(&db, &json!({"searchTerm":"fresh"})).unwrap()["data"][0]["id"],
            "new"
        );
        assert!(
            list_connection(&db, &json!({"cwd":["/other"]})).unwrap()["data"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
}
