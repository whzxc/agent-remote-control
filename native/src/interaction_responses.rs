//! Durable answers sent through the native owner, independent of renderer caches.
use crate::kernel::file_cache::{self, load};
use crate::*;
fn directory(thread: &str) -> PathBuf {
    root().join("interaction-responses").join(hash(thread))
}
/// A bounded attribution owned by ARC; native session storage is never changed.
pub(crate) fn answered_by(origin: &Value) -> Value {
    if origin["ingressId"] == "local-ui" {
        json!({"kind":"local-ui"})
    } else if let Some(source) = origin["sourceId"]
        .as_str()
        .filter(|id| !id.is_empty() && id.len() <= 256)
    {
        json!({"kind":"source","sourceId":source})
    } else {
        json!({"kind":"unknown"})
    }
}
pub(crate) fn current_answered_by() -> Value {
    answered_by(&crate::kernel::origin::current_origin())
}
pub(crate) fn record(request: &Value, args: &Value) -> Result<()> {
    let thread = string(&request["params"], "threadId");
    if thread.is_empty() {
        return Err("INTERACTION_THREAD_MISSING".into());
    }
    let value = json!({"request":request,"response":{"result":args["result"],"error":args["error"],"skipped":args["skipped"] == true,"origin":crate::kernel::origin::current_origin(),"answeredBy":current_answered_by(),"resolvedAt":now()}});
    save(&directory(thread).join(format!("{}.json",hash(json!([request["backendSession"], request["params"]["turnId"], request["id"]]).to_string()))), &value)
        .map_err(|e| format!("SUBMISSION_UNCONFIRMED: response acknowledged but answer persistence failed: {e}; read the original receipt"))
}
pub(crate) fn project(timeline: &mut crate::task_tracking::Timeline, thread: &str) -> Result<()> {
    for row in answers(&directory(thread))? {
        timeline.answered(&row["request"], &row["response"]);
    }
    Ok(())
}
fn answers(directory: &Path) -> Result<Vec<Value>> {
    if !directory.exists() {
        return Ok(Vec::new());
    }
    let mut rows = file_cache::entries(directory)?
        .iter()
        .filter(|e| e.path.extension().is_some_and(|v| v == "json"))
        .map(|e| load(&e.path))
        .collect::<Result<Vec<_>>>()?;
    rows.sort_by(|a, b| {
        string(&a["response"], "resolvedAt").cmp(string(&b["response"], "resolvedAt"))
    });
    Ok(rows)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn answer_attribution_is_bounded_and_never_inferred_from_a_label() {
        // Property: attribution uses explicit local UI ingress or a bounded source id, never a display label.
        assert_eq!(
            answered_by(&json!({"ingressId":"local-ui","sourceId":"local"})),
            json!({"kind":"local-ui"})
        );
        assert_eq!(
            answered_by(&json!({"sourceId":"controller","sourceLabel":"Example"})),
            json!({"kind":"source","sourceId":"controller"})
        );
        for origin in [
            Value::Null,
            json!({"sourceLabel":"Example"}),
            json!({"sourceId":"x".repeat(257)}),
        ] {
            assert_eq!(answered_by(&origin), json!({"kind":"unknown"}));
        }
    }
    #[test]
    fn timeline_read_keeps_the_answering_party() {
        // Regression: answered timeline entries omitted the party that brokered the answer.
        let mut timeline = crate::task_tracking::Timeline::default();
        timeline.answered(&json!({"id":"approval","method":"item/commandExecution/requestApproval","params":{"turnId":"turn"}}),
            &json!({"result":{"decision":"accept"},"answeredBy":answered_by(&json!({"sourceId":"fixture-controller"})),"resolvedAt":"2026-01-01T00:00:00Z"}));
        let response = timeline.response("fixture", 0);
        assert_eq!(
            response["entries"][0]["response"]["answeredBy"],
            json!({"kind":"source","sourceId":"fixture-controller"})
        );
    }
    #[test]
    fn timeline_polls_reuse_answers_and_pick_up_a_new_response() {
        // Regression: the one-second timeline poll enumerated and reread every persisted answer.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-answer-cache-{}", id())));
        for n in 0..100 {
            save(&dir.0.join(format!("{n}.json")), &json!({"request":{"id":n},"response":{"resolvedAt":"2026-01-01T00:00:00Z","result":n}})).unwrap();
        }
        assert_eq!(answers(&dir.0).unwrap().len(), 100);
        let warm = file_cache::thread_io();
        for _ in 0..3 {
            assert_eq!(answers(&dir.0).unwrap().len(), 100);
        }
        assert_eq!(file_cache::thread_io(), warm);
        save(&dir.0.join("new.json"), &json!({"request":{"id":"new"},"response":{"resolvedAt":"2026-01-02T00:00:00Z","result":"accepted"}})).unwrap();
        let rows = answers(&dir.0).unwrap();
        assert_eq!(rows.len(), 101);
        assert_eq!(rows.last().unwrap()["response"]["result"], "accepted");
        assert_eq!(file_cache::thread_io().file_opens - warm.file_opens, 1);
        assert_eq!(
            file_cache::thread_io().directory_reads,
            warm.directory_reads
        );
    }
}
