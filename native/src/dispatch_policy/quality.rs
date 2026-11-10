//! Bounded observations of quality gates, independent of execution outcomes.
use super::*;
use std::collections::{BTreeMap, HashSet};
pub(super) const MAX_ROWS: usize = 4096;
const MAX_REVIEWS: usize = 32;

pub(super) fn normalize(review: &mut Value, legacy: bool) {
    if review["qualityVersion"] == 1 {
        return;
    }
    if legacy {
        static PREFIX: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
            regex::Regex::new(r"^found-by: (controller|acceptance|ci|user); defects: ([0-9]+); advisory: ([0-9]+)(?:;|\s|$)").unwrap()
        });
        let parsed = PREFIX.captures(string(review, "note")).and_then(|c| {
            let by = match &c[1] {
                "ci" => "automation",
                "controller" => "controller",
                "acceptance" => "acceptance",
                "user" => "user",
                _ => return None,
            };
            Some((by, c[2].parse::<u64>().ok()?, c[3].parse::<u64>().ok()?))
        });
        if let Some((by, defects, advisory)) = parsed {
            review["foundBy"] = json!(by);
            review["defects"] = json!(defects);
            review["advisory"] = json!(advisory);
        } else {
            review["foundBy"] = json!("unknown");
        }
    } else {
        let omitted_gate = review["foundBy"].is_null();
        if omitted_gate {
            review["foundBy"] = json!("unknown");
        }
        if omitted_gate && review["verdict"] == "pass" && review["defects"].is_null() {
            review["defects"] = json!(0);
        }
    }
    review["qualityVersion"] = json!(1);
}

pub(super) fn import(row: &mut Value) -> bool {
    let mut changed = false;
    if row["review"].is_object() && row["review"]["qualityVersion"] != 1 {
        normalize(&mut row["review"], true);
        changed = true;
    }
    changed
}

pub(super) fn attach(row: &mut Value, review: &Value) {
    import(row);
    let mut observations = row["reviewObservations"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if row["review"].is_object() && !observations.contains(&row["review"]) {
        observations.push(row["review"].clone());
    }
    if !observations
        .iter()
        .any(|r| r["requestId"] == review["requestId"] && r["reviewedAt"] == review["reviewedAt"])
    {
        observations.push(review.clone());
    }
    if observations.len() > MAX_REVIEWS {
        observations.drain(..observations.len() - MAX_REVIEWS);
        row["reviewHistoryGap"] = json!(true);
    }
    row["reviewObservations"] = json!(observations);
    row["review"] = review.clone();
}

#[derive(Default)]
struct Findings {
    reviews: u64,
    defects: u64,
    advisory: u64,
    unknown: u64,
}
impl Findings {
    fn add(&mut self, r: &Value) {
        self.reviews += 1;
        self.defects += r["defects"].as_u64().unwrap_or(0);
        self.advisory += r["advisory"].as_u64().unwrap_or(0);
        self.unknown +=
            u64::from(r["defects"].as_u64().is_none() || r["advisory"].as_u64().is_none());
    }
    fn value(&self) -> Value {
        json!({"reviews":self.reviews,"defects":self.defects,"advisory":self.advisory,
            "unknownCounts":self.unknown,"coverage":if self.unknown == 0 {"exact"} else if self.unknown == self.reviews {"unknown"} else {"bounded"}})
    }
}

pub(super) fn aggregate(
    rows: &[Value],
    agent: &str,
    cutoff: chrono::DateTime<chrono::Utc>,
) -> Value {
    let mut by = BTreeMap::<String, Findings>::new();
    let mut users = Findings::default();
    let mut external = Findings::default();
    let mut self_tests = 0;
    let (
        mut reviewed,
        mut unreviewed,
        mut completed,
        mut running,
        mut unknown,
        mut immature,
        mut mature,
    ) = (0, 0, 0, 0, 0, 0, 0);
    let mut gap = rows.len() > MAX_ROWS;
    let mut history_unknown = 0;
    let mut maturity_unknown = 0;
    let mut running_unknown = 0;
    let mut seen = HashSet::new();
    for row in rows.iter().take(MAX_ROWS) {
        crate::runtime_metrics::cost::rows(1);
        let is_external = row["dispatchOrigin"] == "external";
        let time = if is_external {
            &row["review"]["reviewedAt"]
        } else {
            &row["submittedAt"]
        };
        if row["agent"].as_str().unwrap_or("codex") == agent
            && time
                .as_str()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .is_none()
        {
            history_unknown += 1;
        }
        if row["agent"].as_str().unwrap_or("codex") != agent
            || !chrono::DateTime::parse_from_rfc3339(time.as_str().unwrap_or(""))
                .is_ok_and(|t| t >= cutoff)
            || (!is_external
                && (row["dispatchMode"] != "new-turn"
                    || (agent != "codex" && row["submission"] != "accepted")))
            || !seen.insert((string(row, "threadId"), string(row, "turnId")))
        {
            continue;
        }
        if row["purpose"] == "self-test" {
            self_tests += 1;
            continue;
        }
        if !is_external {
            if row["review"].is_object() {
                reviewed += 1;
            } else {
                unreviewed += 1;
            }
            match string(&row["terminal"], "state") {
                "completed" if !row["review"].is_object() => completed += 1,
                "completed" | "failed" | "interrupted" | "cancelled" => {}
                "running" | "inProgress" => running += 1,
                _ => {
                    unknown += 1;
                    if row["terminal"].is_null() {
                        running += 1;
                        running_unknown += 1;
                    }
                }
            }
            match chrono::DateTime::parse_from_rfc3339(string(&row["terminal"], "endedAt")) {
                Ok(t) if t <= cutoff + chrono::Duration::days(16) => mature += 1,
                Ok(_) => immature += 1,
                Err(_) => maturity_unknown += 1,
            }
        }
        gap |= row["reviewHistoryGap"] == true;
        let mut observations = row["reviewObservations"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if row["review"].is_object() && !observations.contains(&row["review"]) {
            observations.push(row["review"].clone());
        }
        gap |= observations.len() > MAX_REVIEWS;
        for mut r in observations.into_iter().rev().take(MAX_REVIEWS) {
            crate::runtime_metrics::cost::rows(1);
            normalize(&mut r, true);
            if is_external {
                external.add(&r);
                continue;
            }
            if r["foundBy"] == "user" {
                users.add(&r);
            } else {
                by.entry(string(&r, "foundBy").to_owned())
                    .or_default()
                    .add(&r);
            }
        }
    }
    let mut result = json!({"reviewerFindings":by.into_iter().map(|(k,v)|(k,v.value())).collect::<BTreeMap<_,_>>(),
        "laterUserFindings":users.value(),"unreviewedCompletions":{"count":completed,"coverage":if gap {"bounded"} else {"exact"}},
        "stillRunning":{"count":running,"unconfirmed":running_unknown,"coverage":if running_unknown > 0 {"unknown"} else if gap {"bounded"} else {"exact"}},"executionUnknown":unknown,
        "reviewCoverage":{"reviewed":reviewed,"unreviewed":unreviewed,"coverage":if gap {"bounded"} else {"exact"}},
        "externalReviews":external.value(),"selfTests":{"count":self_tests,"coverage":"exact"},
        "maturity":{"windowDays":14,"immature":immature,"mature":mature,"unknown":maturity_unknown},
        "historyUnknownRows":history_unknown,
        "coverage":if history_unknown > 0 {"unknown"} else if gap {"bounded"} else {"exact"},
        "interpretation":"Reported finding observations only. A pass is a review verdict; defect absence is unknown."});
    if gap {
        result["laterUserFindings"]["coverage"] = json!("bounded");
        for v in result["reviewerFindings"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            v["coverage"] = json!("bounded");
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn structured_counts_and_legacy_prefix_are_not_inferred_from_prose() {
        // Regression: quality gates retained only prose and legacy passes were mistaken for zero defects.
        for (note, by) in [
            ("controller", "controller"),
            ("acceptance", "acceptance"),
            ("ci", "automation"),
            ("user", "user"),
        ] {
            let mut row = json!({"review":{"verdict":"pass","note":format!("found-by: {note}; defects: 2; advisory: 3; details")}});
            assert!(import(&mut row));
            assert_eq!(row["review"]["foundBy"], by);
            assert_eq!(row["review"]["defects"], 2);
            assert_eq!(row["review"]["advisory"], 3);
            assert!(!import(&mut row));
        }
        let mut legacy =
            json!({"review":{"verdict":"pass","note":"User found two errors; tests passed"}});
        import(&mut legacy);
        assert_eq!(legacy["review"]["foundBy"], "unknown");
        assert!(legacy["review"]["defects"].is_null());
        let pass = review_record(
            &json!({"verdict":"pass"}),
            &Value::Null,
            None,
            &Value::Null,
            "now",
        );
        assert_eq!(pass["foundBy"], "unknown");
        assert_eq!(pass["defects"], 0);
        let pass = review_record(
            &json!({"verdict":"pass","foundBy":"installed","defects":2,"advisory":1}),
            &Value::Null,
            None,
            &Value::Null,
            "now",
        );
        assert_eq!(pass["defects"], 2);
        assert_eq!(pass["foundBy"], "installed");
        assert_eq!(pass["advisory"], 1);
    }

    #[test]
    fn outcomes_review_coverage_and_later_user_findings_are_independent() {
        // Regression: failed and interrupted executions disappeared from unreviewed coverage and a later user review erased controller findings.
        let at = chrono::Utc::now() - chrono::Duration::days(20);
        let mut controller = json!({"agent":"codex","threadId":"t","turnId":"reviewed","dispatchMode":"new-turn","submittedAt":at.to_rfc3339(),"terminal":{"state":"completed","endedAt":at.to_rfc3339()}});
        let first = review_record(
            &json!({"verdict":"rework","foundBy":"controller","defects":2,"advisory":1,"requestId":"first"}),
            &Value::Null,
            Some(&controller),
            &Value::Null,
            &at.to_rfc3339(),
        );
        attach(&mut controller, &first);
        let later = review_record(
            &json!({"verdict":"rework","foundBy":"user","defects":1,"advisory":0,"requestId":"later"}),
            &Value::Null,
            Some(&controller),
            &Value::Null,
            &chrono::Utc::now().to_rfc3339(),
        );
        attach(&mut controller, &later);
        let mut rows = vec![controller.clone()];
        for (id, state) in [
            ("unreviewed", "completed"),
            ("active", "running"),
            ("failed", "failed"),
            ("interrupted", "interrupted"),
            ("gap", ""),
        ] {
            let mut row = controller.clone();
            row["turnId"] = json!(id);
            row.as_object_mut().unwrap().remove("review");
            row.as_object_mut().unwrap().remove("reviewObservations");
            row["terminal"] = json!({"state":state,"endedAt":at.to_rfc3339()});
            rows.push(row);
        }
        let history = summarize_history(&rows, "codex", false, at - chrono::Duration::days(1));
        assert_eq!(history["groups"][0]["unreviewed"], 5);
        let q = &history["quality"];
        assert_eq!(q["reviewerFindings"]["controller"]["defects"], 2);
        assert_eq!(q["laterUserFindings"]["defects"], 1);
        assert_eq!(q["reviewCoverage"]["unreviewed"], 5);
        assert_eq!(q["unreviewedCompletions"]["count"], 1);
        assert_eq!(q["stillRunning"]["count"], 1);
        assert!(q["executionUnknown"].as_u64().unwrap() > 0);
    }

    #[test]
    fn digest_keeps_unknown_coverage_and_new_review_fields_validate() {
        // Contract: dispatch_policy digest preserves unknown quality counts and both review ops accept structured non-negative findings.
        let specs = crate::catalog();
        for name in ["codex_review", "agent_review", "dispatch_policy"] {
            let spec = specs["ops"]
                .as_array()
                .unwrap()
                .iter()
                .find(|op| op["name"] == name)
                .unwrap();
            let args = match name {
                "codex_review" => {
                    json!({"threadId":"thread","verdict":"pass","foundBy":"acceptance","defects":2,"advisory":1})
                }
                "agent_review" => {
                    json!({"agent":"pi","taskId":"00000000-0000-4000-8000-000000000001","verdict":"rework","foundBy":"user","defects":1,"advisory":0})
                }
                _ => json!({"view":"digest"}),
            };
            crate::egress::validate_op(spec, &args).unwrap();
        }
        let row = json!({"agent":"codex","threadId":"t","turnId":"turn","dispatchMode":"new-turn","submittedAt":now(),"review":{"verdict":"pass","note":"Tests passed"}});
        let history = summarize_history(
            &[row],
            "codex",
            true,
            chrono::Utc::now() - chrono::Duration::days(30),
        );
        let result = super::super::decision::present(
            json!({"criteria":"","agents":[{"agent":"codex","history":history}]}),
            &json!({"view":"digest"}),
        );
        assert_eq!(
            result["agents"][0]["history"]["quality"]["reviewerFindings"]["unknown"]["coverage"],
            "unknown"
        );
        assert_eq!(
            result["agents"][0]["history"]["quality"]["laterFixCorrelation"],
            Value::Null
        );
    }

    #[test]
    fn retained_history_keeps_newest_window_rows_and_bounds_only_window_overflow() {
        // Regression: an oldest-first retained-history cap discarded recent turns once retention exceeded 4096 records.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-history-recency-{}", id())));
        let old_thread = dir
            .0
            .join("dispatches/00000001-0000-7000-8000-000000000000");
        let new_thread = dir
            .0
            .join("dispatches/000000ff-0000-7000-8000-000000000000");
        let time = chrono::Utc::now();
        let old = time - chrono::Duration::days(60);
        let row = |id: &str, at: chrono::DateTime<chrono::Utc>| json!({"agent":"codex","threadId":"thread","turnId":id,"dispatchMode":"new-turn","submittedAt":at.to_rfc3339(),"terminal":{"state":"completed","endedAt":at.to_rfc3339()}});
        for n in 0..MAX_ROWS + 1 {
            let path = old_thread.join(format!("{n:05}.json"));
            save(&path, &row(&format!("old-{n}"), old)).unwrap();
            std::fs::File::open(&path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(old.into()))
                .unwrap();
        }
        save(
            &old_thread.join("recent.json"),
            &row("recent-old-thread", time - chrono::Duration::days(29)),
        )
        .unwrap();
        save(&new_thread.join("recent.json"), &row("newest-thread", time)).unwrap();
        let mut external = row("external", old);
        external["dispatchOrigin"] = json!("external");
        external["review"] = json!({"verdict":"pass","reviewedAt":time.to_rfc3339(),"foundBy":"controller","defects":0,"advisory":0,"qualityVersion":1});
        save(
            &dir.0
                .join("reviews/00000001-0000-7000-8000-000000000000/recent.json"),
            &external,
        )
        .unwrap();
        // Recently modified old execution records must still be excluded by their actual timestamp.
        save(
            &new_thread.join("updated-old.json"),
            &row("updated-old", old),
        )
        .unwrap();
        let io = file_cache::thread_io();
        let selected = history_rows_in(&dir.0).unwrap();
        assert_eq!(selected.len(), 3);
        assert_eq!(file_cache::thread_io().file_opens - io.file_opens, 4);
        let initial = history_from_rows(&selected, "codex", false, &dir.0);
        assert_eq!(initial["coverage"], "exact");
        assert_eq!(initial["quality"]["reviewCoverage"]["unreviewed"], 2);
        assert_eq!(initial["quality"]["externalReviews"]["reviews"], 1);
        for n in 0..MAX_ROWS - 3 {
            save(
                &new_thread.join(format!("{n:05}.json")),
                &row(
                    &format!("current-{n}"),
                    time - chrono::Duration::minutes(n as i64 + 1),
                ),
            )
            .unwrap();
        }
        let exact = history_rows_in(&dir.0).unwrap();
        assert_eq!(exact.len(), MAX_ROWS);
        assert_eq!(
            history_from_rows(&exact, "codex", false, &dir.0)["coverage"],
            "exact"
        );
        save(
            &new_thread.join("latest.json"),
            &row("latest", time + chrono::Duration::seconds(1)),
        )
        .unwrap();
        let bounded = history_rows_in(&dir.0).unwrap();
        assert_eq!(bounded.len(), MAX_ROWS + 1);
        assert_eq!(bounded[0]["turnId"], "latest");
        assert!(bounded[..MAX_ROWS]
            .iter()
            .any(|r| r["turnId"] == "newest-thread"));
        assert!(!bounded[..MAX_ROWS]
            .iter()
            .any(|r| r["turnId"] == "recent-old-thread"));
        assert_eq!(
            history_from_rows(&bounded, "codex", false, &dir.0)["coverage"],
            "bounded"
        );
        let io = file_cache::thread_io();
        assert_eq!(history_rows_in(&dir.0).unwrap(), bounded);
        assert_eq!(file_cache::thread_io().file_opens, io.file_opens);
    }

    #[test]
    fn legacy_file_import_writes_once_and_warm_reads_never_write() {
        // Regression: legacy found-by imports must persist once and leave repeated warm history reads write-free.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-review-import-{}", id())));
        for (name, note) in [
            (
                "structured",
                "found-by: controller; defects: 2; advisory: 1",
            ),
            ("prose", "Tests passed"),
        ] {
            save(
                &dir.0.join(format!("{name}.json")),
                &json!({"turnId":name,"review":{"verdict":"pass","note":note}}),
            )
            .unwrap();
        }
        use crate::runtime_metrics::cost::{self, Owner, Reason};
        let metrics = || crate::runtime_metrics::snapshot()["cost"]["taskRead"].clone();
        let read = || {
            cost::sync(Owner::TaskRead, Reason::Poll, || {
                read_rows_limit(&dir.0, usize::MAX).unwrap()
            })
        };
        let before = metrics();
        let first = read();
        assert_eq!(
            metrics()["recordsChanged"].as_u64().unwrap()
                - before["recordsChanged"].as_u64().unwrap(),
            2
        );
        let stamps = || {
            ["structured", "prose"]
                .map(|name| file_cache::Stamp::read(&dir.0.join(format!("{name}.json"))).unwrap())
        };
        let imported = stamps();
        assert_eq!(read(), first);
        let warm = metrics();
        for _ in 0..3 {
            assert_eq!(read(), first);
        }
        let after = metrics();
        assert_eq!(after["recordsChanged"], warm["recordsChanged"]);
        assert_eq!(
            after["recordsChanged"].as_u64().unwrap() - before["recordsChanged"].as_u64().unwrap(),
            2
        );
        assert_eq!(after["bytesParsed"], warm["bytesParsed"]);
        assert_eq!(stamps(), imported);
    }

    #[test]
    fn installed_scale_history_cost_is_independent_of_receipts() {
        // Regression: D4d quality aggregation must visit only dispatch/review owners after warming, regardless of receipt volume.
        struct Sandbox(PathBuf);
        impl Drop for Sandbox {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let dir = Sandbox(std::env::temp_dir().join(format!("arc-quality-scale-{}", id())));
        let base = &dir.0;
        for n in 0..300 {
            let at = chrono::Utc::now() - chrono::Duration::hours(n * 24 / 10);
            let args = json!({"verdict":"pass","foundBy":"segment","defects":n%3,"advisory":0,"requestId":n});
            let review = review_record(&args, &Value::Null, None, &Value::Null, &at.to_rfc3339());
            save(&base.join("dispatches/thread").join(format!("{n}.json")),&json!({"agent":"codex","threadId":"thread","turnId":n.to_string(),"dispatchMode":"new-turn","submittedAt":at.to_rfc3339(),"terminal":{"state":"completed","endedAt":at.to_rfc3339()},"review":review})).unwrap();
        }
        use crate::runtime_metrics::cost::{self, Owner, Reason};
        let read = || {
            cost::sync(Owner::TaskRead, Reason::Poll, || {
                let rows = history_rows_in(base).unwrap();
                history_from_rows(&rows, "codex", false, base)
            })
        };
        let metrics = || crate::runtime_metrics::snapshot()["cost"]["taskRead"].clone();
        let before = metrics();
        let first = read();
        let cold = metrics();
        assert_eq!(first["quality"]["reviewCoverage"]["reviewed"], 300);
        let mut costs = vec![];
        for receipts in [0, 8000] {
            for n in 0..receipts {
                save(
                    &base.join(format!("{}.json", uuid::Uuid::from_u128(n as u128))),
                    &json!({"requestId":n,"state":"completed"}),
                )
                .unwrap();
            }
            let before = metrics();
            assert_eq!(read()["quality"], first["quality"]);
            let after = metrics();
            let rows =
                after["rowsVisited"].as_u64().unwrap() - before["rowsVisited"].as_u64().unwrap();
            let bytes =
                after["bytesParsed"].as_u64().unwrap() - before["bytesParsed"].as_u64().unwrap();
            costs.push((rows, bytes));
        }
        println!(
            "D4d installed-scale cold rows={} bytes={}; warm 0/8000 receipts={costs:?}",
            cold["rowsVisited"].as_u64().unwrap() - before["rowsVisited"].as_u64().unwrap(),
            cold["bytesParsed"].as_u64().unwrap() - before["bytesParsed"].as_u64().unwrap()
        );
        assert_eq!(costs[0], costs[1]);
        assert_eq!(costs[0].1, 0);
        save(&base.join("dispatches/thread/0.json"),&json!({"agent":"codex","threadId":"thread","turnId":"0","dispatchMode":"new-turn","submittedAt":now(),"terminal":{"state":"completed"}})).unwrap();
        assert_eq!(read()["quality"]["reviewCoverage"]["unreviewed"], 1);
    }
}
