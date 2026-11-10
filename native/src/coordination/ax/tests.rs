use super::*;
struct Fixture {
    path: PathBuf,
    store: Store,
    time: i64,
    actor: Value,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("arc-ax-fixture-{}", id()));
        Self {
            store: Store::open(path.clone()).unwrap(),
            path,
            time: 1_800_000_000_000,
            actor: json!({"type":"source","sourceId":"one","accountId":"account-one"}),
        }
    }
    fn call(&mut self, op: &str, mut args: Value) -> Value {
        if op != "ax_list" && args["requestId"].is_null() {
            args["requestId"] = json!(id());
        }
        let result=validate(op,&args).and_then(|_| {
            if op=="ax_list" {self.store.list(&args,&self.actor,"authority-1",self.time)}
            else {self.store.mutate(op,&args,&self.actor,vec![json!({"kind":"observation","coreBuild":"fixture-build","observedAt":timestamp(self.time)})],self.time)}
        });
        crate::egress::tool(result.unwrap_or_else(|e| failure(e, op, &args)), false)
            ["structuredContent"]["result"]
            .clone()
    }
    fn report(&mut self, symptom: &str) -> Value {
        self.call("ax_report",json!({"symptom":symptom,"expected":"Bounded actionable result","severity":"workaround"}))["entry"].clone()
    }
    fn decide(&mut self, e: &Value, action: &str) -> Value {
        self.call(if matches!(action,"confirm"|"reject") {"ax_candidate"}else{"ax_triage"},json!({"id":e["id"],"expectedRevision":e["revision"],"action":action,"reason":"Fixture decision"}))["entry"].clone()
    }
    fn drain(&mut self) {
        for event in self.store.pending() {
            self.store.projected(&event.transition_id).unwrap();
        }
    }
    fn restart(&mut self) {
        self.store = Store::open(self.path.clone()).unwrap();
    }
    fn candidate(&mut self, observation: &str, build: &str) -> Value {
        let source = serde_json::from_value(self.actor.clone()).unwrap();
        self.store
            .candidate(
                Friction::StalledReceipt,
                observation,
                Some(source),
                vec![],
                build,
                self.time,
            )
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

#[test]
// Contract: AX operations retain frozen query/act envelopes and reject caller-selected origin or version.
fn ax_contract_shapes() {
    let c = catalog();
    for name in ["ax_report", "ax_list", "ax_candidate", "ax_triage"] {
        let spec = c["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["name"] == name)
            .unwrap();
        assert_eq!(
            crate::egress::via(spec),
            if name == "ax_list" { "query" } else { "act" }
        );
        assert_eq!(
            crate::egress::retry_contract(spec)["mode"],
            if name == "ax_list" {
                "read-only"
            } else {
                "receipt"
            }
        );
        let mut invalid = spec["example"].clone();
        invalid["source"] = json!("spoofed");
        assert!(validate(name, &invalid).is_err());
        invalid = spec["example"].clone();
        invalid["arcVersion"] = json!("spoofed");
        assert!(validate(name, &invalid).is_err());
        assert!(validate(name, &spec["example"]).is_ok());
    }
    assert!(validate("ax_report", &json!({"symptom":"x","expected":"y"})).is_err());
    assert!(validate(
        "ax_report",
        &json!({"kind":"idea","symptom":"x","expected":"y"})
    )
    .is_ok());
}
#[test]
// Contract: ax_report retries reconcile durable owner records once across restart, and exact evidence dedupes.
fn ax_retry_dedupe_and_similarity() {
    let mut f = Fixture::new();
    let args = json!({"requestId":id(),"symptom":"Owner discovery timeout for idle thread","expected":"Bounded result","severity":"blocking","receiptIds":["receipt-one"]});
    let first = f.call("ax_report", args.clone());
    f.restart();
    let retry = f.call("ax_report", args.clone());
    assert_eq!(retry["entry"]["id"], first["entry"]["id"]);
    assert_eq!(retry["entry"]["occurrenceCount"], 1);
    let mut again = args.clone();
    again["requestId"] = json!(id());
    assert_eq!(
        f.call("ax_report", again.clone())["entry"]["occurrenceCount"],
        1
    );
    again["requestId"] = json!(id());
    again["receiptIds"] = json!(["receipt-two"]);
    assert_eq!(
        f.call("ax_report", again.clone())["entry"]["occurrenceCount"],
        2
    );
    again["requestId"] = json!(id());
    again["symptom"] = json!("Owner discovery timeout for active thread");
    let similar = f.call("ax_report", again);
    assert_ne!(similar["entry"]["id"], first["entry"]["id"]);
    assert_eq!(
        similar["duplicateCandidates"][0]["id"],
        first["entry"]["id"]
    );
    assert_eq!(f.call("ax_list", json!({}))["counts"]["open"], 2);
}
#[test]
fn ax_candidate_occurrences_reuse_signature_across_builds_and_sources() {
    // Regression: ax-23f33aae repeated receipt stalls created separate candidates and lost cooldown occurrences.
    let mut f = Fixture::new();
    let first = f.candidate("observation-one", "build-a")["entry"].clone();
    assert_eq!(first["occurrenceCount"], 1);
    f.actor["sourceId"] = json!("two");
    let second = f.candidate("observation-two", "build-b")["entry"].clone();
    assert_eq!(second["id"], first["id"]);
    assert_eq!(second["occurrenceCount"], 2);
    let denied=f.call("ax_candidate",json!({"id":second["id"],"expectedRevision":second["revision"],"action":"confirm","reason":"Checked"}));
    assert_eq!(denied["error"]["code"], "AX_FORBIDDEN");
    f.actor["sourceId"] = json!("one");
    let confirmed = f.decide(&second, "confirm");
    assert_eq!(confirmed["status"], "open");
    assert_eq!(confirmed["occurrenceCount"], 2);
    let next = f.candidate("observation-three", "build-c")["entry"].clone();
    assert_eq!(next["id"], first["id"]);
    assert_eq!(next["occurrenceCount"], 3);
    f.restart();
    assert_eq!(
        f.candidate("observation-three", "build-d")["coalesced"],
        true
    );
    assert_eq!(f.call("ax_list", json!({}))["counts"]["candidates"], 0);
    assert_eq!(f.call("ax_list", json!({}))["counts"]["open"], 1);
}
#[test]
fn ax_candidate_rejection_is_build_scoped() {
    // Contract: rejection suppresses one signature for the rejected build without suppressing changed builds.
    let mut f = Fixture::new();
    let first = f.candidate("one", "build-a")["entry"].clone();
    assert_eq!(f.decide(&first, "reject")["candidateState"], "rejected");
    assert_eq!(f.candidate("two", "build-a")["suppressed"], true);
    assert_eq!(
        f.candidate("three", "build-b")["entry"]["status"],
        "candidate"
    );
}
#[test]
fn imported_ax_entries_require_local_authority() {
    // Regression: imported AX entries need local triage recovery without attributing unrelated candidate observations to a backlog ID.
    let mut f = Fixture::new();
    let imported = f
        .store
        .import_queue(include_str!("queue-fixture.md"), f.time)
        .unwrap();
    let current = imported["entries"][0].clone();
    let denied = f.call("ax_triage",json!({"id":current["id"],"expectedRevision":current["revision"],"action":"wontfix","reason":"Fixture"}));
    assert_eq!(denied["error"]["code"], "AX_FORBIDDEN");
    assert_eq!(
        denied["next"]["command"],
        "arc cli control ax_triage --stdin"
    );
    let found = f.candidate("fresh-stall", "new-build")["entry"].clone();
    assert_ne!(found["id"], current["id"]);
    assert_eq!(found["status"], "candidate");
    f.actor = json!({"type":"local-authority"});
    assert_eq!(f.decide(&current, "wontfix")["status"], "closed");
}

#[test]
// Contract: triage preserves revisions/history, requires verification beyond a commit, and merges unique occurrences without cycles.
fn ax_triage_history_merge_and_recurrence() {
    let mut f = Fixture::new();
    let first = f.report("Idle owner discovery failed");
    let triaged=f.call("ax_triage",json!({"id":first["id"],"expectedRevision":first["revision"],"action":"fix","reason":"Change landed","commit":"abc123"}))["entry"].clone();
    assert_eq!(triaged["status"], "triaged");
    let conflict=f.call("ax_triage",json!({"id":first["id"],"expectedRevision":first["revision"],"action":"wontfix","reason":"Stale decision"}));
    assert_eq!(conflict["error"]["code"], "AX_REVISION_CONFLICT");
    let closed = f.decide(&triaged, "wontfix");
    assert_eq!(closed["status"], "closed");
    let recurrence = f.report("Idle owner discovery failed");
    assert_eq!(recurrence["id"], first["id"]);
    assert_eq!(recurrence["status"], "open");
    assert_eq!(recurrence["occurrenceCount"], 2);
    assert_eq!(recurrence["history"].as_array().unwrap().len(), 4);
    let second = f.report("Active owner discovery failed");
    let merged=f.call("ax_triage",json!({"id":second["id"],"expectedRevision":second["revision"],"action":"merged","mergedInto":first["id"],"reason":"Same cause"}))["entry"].clone();
    assert_eq!(merged["status"], "merged");
    assert_eq!(merged["occurrenceCount"], 1);
    let canonical = f.call("ax_list", json!({"id":first["id"]}))["entries"][0].clone();
    assert_eq!(canonical["occurrenceCount"], 3);
    let cycle=f.call("ax_triage",json!({"id":first["id"],"expectedRevision":canonical["revision"],"action":"merged","mergedInto":second["id"],"reason":"Cycle"}));
    assert_eq!(cycle["error"]["code"], "AX_MERGE_CYCLE");
    let observed = f.report("Active owner discovery failed");
    assert_eq!(observed["id"], first["id"]);
    assert_eq!(observed["occurrenceCount"], 4);
}
#[test]
// Contract: shared AX lists redact reproduction/evidence and bind paging cursors to authority, filters and snapshot.
fn ax_visibility_paging_and_filters() {
    let mut f = Fixture::new();
    f.call("ax_report",json!({"symptom":"Stalled receipt","expected":"Progress","severity":"blocking","reproductionHints":"private-detail"}));
    f.report("Delivery failed");
    let first = f.call("ax_list", json!({"limit":1}));
    assert!(first["nextCursor"].is_string());
    assert_eq!(first["triageDue"], true);
    let second = f.call("ax_list", json!({"limit":1,"cursor":first["nextCursor"]}));
    assert_ne!(first["entries"][0]["id"], second["entries"][0]["id"]);
    f.actor["accountId"] = json!("merged-account");
    assert!(
        f.call("ax_list", json!({"limit":1,"cursor":first["nextCursor"]}))["entries"].is_array()
    );
    f.actor["sourceId"] = json!("two");
    f.actor["accountId"] = json!("account-two");
    assert_eq!(
        f.call("ax_list", json!({"cursor":first["nextCursor"]}))["error"]["code"],
        "AX_CURSOR_EXPIRED"
    );
    let shared = f.call("ax_list", json!({"severity":"blocking","state":"open"}));
    assert_eq!(shared["entries"].as_array().unwrap().len(), 1);
    assert!(shared["entries"][0].get("reproductionHints").is_none());
    assert!(shared["entries"][0].get("evidence").is_none());
    assert_eq!(
        f.call("ax_list", json!({"since":"2099-01-01T00:00:00Z"}))["entries"],
        json!([])
    );
}
#[test]
// Contract: bounded AX mutations reject safely without losing counts/history, and rate limits count distinct attempts only.
fn ax_capacity_and_rate_preserve_last_snapshot() {
    let mut f = Fixture::new();
    let mut entry = f.report("Bounded history");
    for n in 0..100 {
        let before = entry.clone();
        let result=f.call("ax_triage",json!({"id":entry["id"],"expectedRevision":entry["revision"],"action":if n%2==0 {"wontfix"}else{"reopen"},"reason":"r".repeat(1000)}));
        if result["state"] == "failed" {
            assert_eq!(result["error"]["code"], "COORDINATION_CAPACITY");
            f.restart();
            let after = f.call("ax_list", json!({"id":entry["id"]}))["entries"][0].clone();
            assert_eq!(after, before);
            break;
        }
        entry = result["entry"].clone();
        f.drain();
        assert!(n < 99);
    }
    for n in 0..9 {
        f.report(&format!("Rate symptom {n}"));
    }
    assert_eq!(
        f.call(
            "ax_report",
            json!({"symptom":"Overflow","expected":"Bounded","severity":"cosmetic"})
        )["error"]["code"],
        "COORDINATION_RATE_LIMIT"
    );
}
#[test]
// Contract: explicit queue import uses only supplied rows, excludes policy/history and remains idempotent.
fn ax_import_idempotency_and_reported_fixes() {
    let mut f = Fixture::new();
    let text = include_str!("queue-fixture.md");
    assert_eq!(f.store.import_queue("", f.time).unwrap()["imported"], 0);
    let first = f.store.import_queue(text, f.time).unwrap();
    assert_eq!(first["imported"], 4);
    assert_eq!(first["entries"].as_array().unwrap().len(), 4);
    f.restart();
    let again = f.store.import_queue(text, f.time).unwrap();
    assert_eq!(again["imported"], 0);
    assert_eq!(again["unchanged"], 4);
    let entries = again["entries"].as_array().unwrap();
    assert_eq!(entries.iter().filter(|e| e["kind"] == "idea").count(), 1);
    assert!(entries
        .iter()
        .filter(|e| e["kind"] == "idea")
        .all(|e| e["occurrenceCount"] == 0));
    let fixed = entries
        .iter()
        .find(|e| string(e, "symptom").contains("reported fixed"))
        .unwrap();
    assert_eq!(fixed["status"], "open");
    assert!(fixed["evidence"].to_string().contains("reported fixed"));
    assert!(entries
        .iter()
        .all(|e| e["arcVersion"].is_null() && e["firstSeenAt"].is_null()));
    let added=format!("{text}\n- Another bounded metadata follow-up.\n\nPolicy:\n- Must not become an AX entry.\n");
    assert_eq!(f.store.import_queue(&added, f.time).unwrap()["imported"], 1);
}
#[test]
// Contract: closed entries expire only after an explicit durable local export; open entries remain retained.
fn ax_export_before_retention_and_events() {
    let mut f = Fixture::new();
    let entry = f.report("Closed defect");
    f.decide(&entry, "wontfix");
    let open = f.report("Open defect");
    let events = f.store.pending();
    assert!(events.iter().any(|e| e.kind == EventKind::AxCreated));
    assert!(events.iter().any(|e| e.kind == EventKind::AxChanged));
    f.drain();
    f.time += 181 * 86400 * 1000;
    f.report("Retention trigger");
    assert_eq!(
        f.call("ax_list", json!({"id":entry["id"]}))["entries"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let export = f.path.join("fixture-export.json");
    assert_eq!(f.store.export(&export).unwrap()["exported"], 3);
    f.report("Prune trigger");
    assert_eq!(
        f.call("ax_list", json!({"id":entry["id"]}))["entries"],
        json!([])
    );
    assert_eq!(
        f.call("ax_list", json!({"id":open["id"]}))["entries"][0]["status"],
        "open"
    );
}

#[test]
// Contract: receipt/request reference spellings identify one occurrence, including merges and owner severity enrichment.
fn ax_unique_evidence_merges_and_severity_authority() {
    let mut f = Fixture::new();
    let first=f.call("ax_report",json!({"symptom":"Owner timeout","expected":"Bounded result","severity":"workaround","receiptIds":["shared-receipt"]}))["entry"].clone();
    let again=f.call("ax_report",json!({"symptom":"Owner timeout","expected":"Bounded result","severity":"blocking","requestIds":["shared-receipt"],"threadIds":["context-thread"]}))["entry"].clone();
    assert_eq!(again["occurrenceCount"], 1);
    assert_eq!(again["severity"], "blocking");
    assert!(again["revision"].as_u64() > first["revision"].as_u64());
    f.actor["sourceId"] = json!("two");
    let foreign=f.call("ax_report",json!({"symptom":"Owner timeout","expected":"Other expected result","severity":"cosmetic","requestIds":["shared-receipt"]}))["entry"].clone();
    assert_eq!(foreign["severity"], "blocking");
    assert_eq!(foreign["expected"], again["expected"]);
    f.actor["sourceId"] = json!("one");
    let second=f.call("ax_report",json!({"symptom":"Discovery timeout","expected":"Bounded result","severity":"workaround","requestIds":["shared-receipt"]}))["entry"].clone();
    f.call("ax_triage",json!({"id":second["id"],"expectedRevision":second["revision"],"action":"merged","mergedInto":first["id"],"reason":"Same evidenced occurrence"}));
    assert_eq!(
        f.call("ax_list", json!({"id":first["id"]}))["entries"][0]["occurrenceCount"],
        1
    );
}
#[test]
// Contract: fix closure requires available completed verification receipts; unavailable IDs cannot close a defect.
fn ax_verification_evidence_required_for_closure() {
    let mut f = Fixture::new();
    let entry = f.report("Verification needed");
    let mut args = json!({"requestId":id(),"id":entry["id"],"expectedRevision":entry["revision"],"action":"fix","reason":"Reviewed change and checks","commit":"abc123","evidenceIds":["verification-receipt"]});
    let pending = f.call("ax_triage", args.clone())["entry"].clone();
    assert_eq!(pending["status"], "triaged");
    args["requestId"] = json!(id());
    args["expectedRevision"] = pending["revision"].clone();
    validate("ax_triage", &args).unwrap();
    let verified=f.store.mutate("ax_triage",&args,&f.actor,vec![json!({"id":"verification-receipt","availability":"available","state":"completed","operation":"command"})],f.time).unwrap();
    assert_eq!(verified["entry"]["status"], "closed");
    assert_eq!(verified["entry"]["resolution"], "fix");
}

#[test]
fn ax_followup_unclosed_triage_explains_missing_and_rejected_verification() {
    // Regression: ax-a732f88f fix/document stayed triaged without identifying unsupported verification receipts or missing inputs.
    for (action, field) in [("fix", "commit"), ("document", "document")] {
        let mut f = Fixture::new();
        let entry = f.report("Verification explanation");
        let mut args = json!({"requestId":id(),"id":entry["id"],"expectedRevision":entry["revision"],"action":action,"reason":"Verify resolution"});
        let missing = f.call("ax_triage", args.clone());
        assert_eq!(missing["entry"]["status"], "triaged");
        assert_eq!(
            missing["verification"]["reasons"],
            json!([{"code":"missing-change","field":field},{"code":"no-evidence"}])
        );
        assert_eq!(missing["next"]["op"], "ax_list");
        assert_eq!(missing["next"]["args"], json!({"id":entry["id"]}));
        let catalog = catalog();
        let spec = catalog["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|o| o["name"] == missing["next"]["op"])
            .unwrap();
        assert!(crate::egress::validate_op(spec, &missing["next"]["args"]).is_ok());
        args["requestId"] = json!(id());
        args["expectedRevision"] = missing["entry"]["revision"].clone();
        args[field] = json!("change-reference");
        args["evidenceIds"] = json!(["unavailable", "unfinished", "unsupported"]);
        let facts = vec![
            json!({"id":"unavailable","availability":"unavailable"}),
            json!({"id":"unfinished","availability":"available","state":"running","operation":"command"}),
            json!({"id":"unsupported","availability":"available","state":"completed","operation":"ax_triage"}),
        ];
        let rejected = f
            .store
            .mutate("ax_triage", &args, &f.actor, facts, f.time)
            .unwrap();
        assert_eq!(rejected["entry"]["status"], "triaged");
        let reasons = &rejected["verification"]["reasons"];
        for (index, id, reason) in [
            (0, "unavailable", "unavailable"),
            (1, "unfinished", "not-completed"),
            (2, "unsupported", "unsupported-operation"),
        ] {
            assert_eq!(reasons[index]["code"], "evidence-not-accepted");
            assert_eq!(reasons[index]["id"], id);
            assert_eq!(reasons[index]["reason"], reason);
        }
        assert_eq!(reasons[2]["operation"], "ax_triage");
        f.restart();
        let replay = f
            .store
            .mutate("ax_triage", &args, &f.actor, vec![], f.time)
            .unwrap();
        assert_eq!(replay["verification"], rejected["verification"]);
        assert_eq!(replay["next"], rejected["next"]);
        let operations = ["command", "review", "native", "agent_review"];
        args["requestId"] = json!(id());
        args["expectedRevision"] = rejected["entry"]["revision"].clone();
        args["evidenceIds"] = json!(operations);
        let facts = operations
            .iter()
            .map(
                |op| json!({"id":op,"availability":"available","state":"completed","operation":op}),
            )
            .collect();
        let closed = f
            .store
            .mutate("ax_triage", &args, &f.actor, facts, f.time)
            .unwrap();
        assert_eq!(closed["entry"]["status"], "closed");
        assert!(closed.get("verification").is_none());
    }
}
#[test]
// Contract: the 1000-entry bound rejects the next import atomically and candidate overflow stays separate from confirmed counts.
fn ax_entry_bound_and_candidate_overflow() {
    let mut f = Fixture::new();
    let reports:Vec<_>=(0..1000).map(|n|json!({"id":format!("fixture-{n}"),"symptom":format!("Independent defect {n}"),"expected":"Bounded result","kind":"friction","severity":"workaround"})).collect();
    assert_eq!(
        f.store.import_reports(reports, f.time).unwrap()["imported"],
        1000
    );
    let overflow = vec![
        json!({"id":"fixture-overflow","symptom":"Excess record","expected":"Reject safely","kind":"friction","severity":"workaround"}),
    ];
    assert!(f
        .store
        .import_reports(overflow, f.time)
        .unwrap_err()
        .starts_with("COORDINATION_CAPACITY:"));
    f.restart();
    assert_eq!(f.call("ax_list", json!({}))["counts"]["open"], 1000);
    let mut c = Fixture::new();
    for n in 0..20 {
        let entry =
            c.candidate(&format!("observation-{n}"), &format!("build-{n}"))["entry"].clone();
        c.decide(&entry, "reject");
    }
    assert_eq!(
        c.candidate("excess", "build-excess")["reason"],
        "candidate-rate-limit"
    );
    c.restart();
    let list = c.call("ax_list", json!({}));
    assert_eq!(list["counts"]["candidateOverflow"], 1);
    assert_eq!(list["counts"]["open"], 0);
    assert_eq!(list["counts"]["candidates"], 0);
}

#[test]
fn receipt_observer_transition_replay_does_not_duplicate_ax_candidates() {
    // Contract: one receipt-stalled transition remains one AX occurrence across restart, cooldown and confirmation.
    let mut f = Fixture::new();
    let row = json!({"requestId":"stalled-request","state":"reserved","updatedAt":timestamp(f.time),"origin":{"sourceId":"one","accountId":"account-one"}});
    let resource = ResourceKey::parse("host:fixture").unwrap();
    let first = super::super::observers::stalled_input(&row, f.time + 30_000, resource.clone())
        .unwrap()
        .unwrap();
    let candidate = f
        .store
        .candidate(
            Friction::StalledReceipt,
            &first.transition_id,
            first.origin.clone(),
            first.evidence_refs.clone(),
            "fixture-build",
            f.time,
        )
        .unwrap()["entry"]
        .clone();
    f.restart();
    f.time += 660_000;
    let replay = super::super::observers::stalled_input(&row, f.time, resource)
        .unwrap()
        .unwrap();
    assert_eq!(replay.transition_id, first.transition_id);
    let result = f
        .store
        .candidate(
            Friction::StalledReceipt,
            &replay.transition_id,
            replay.origin.clone(),
            replay.evidence_refs.clone(),
            "fixture-build",
            f.time,
        )
        .unwrap();
    assert_eq!(result["id"], candidate["id"]);
    let listed = f.call("ax_list", json!({}));
    assert_eq!(listed["counts"]["candidates"], 1);
    assert_eq!(listed["entries"][0]["revision"], candidate["revision"]);
    let confirmed = f.decide(&candidate, "confirm");
    f.restart();
    f.time += 660_000;
    f.store
        .candidate(
            Friction::StalledReceipt,
            &replay.transition_id,
            replay.origin,
            replay.evidence_refs,
            "fixture-build",
            f.time,
        )
        .unwrap();
    let listed = f.call("ax_list", json!({"id":candidate["id"]}));
    assert_eq!(listed["entries"].as_array().unwrap().len(), 1);
    assert_eq!(listed["entries"][0]["occurrenceCount"], 1);
    assert_eq!(listed["entries"][0]["revision"], confirmed["revision"]);
}

#[test]
// Contract: issue drafts exclude arbitrary prose and identifiers while returning local version, OS and manual submission.
fn ax_issue_draft_sanitization() {
    let private = "notification failed: prompt-secret account@example.invalid /Users/example/private C:\\Users\\example token=abc-secret https://private.invalid/route";
    let args = json!({"friction":private,"receiptIds":["token-secret"],"threadIds":["account@example.invalid"]});
    validate("ax_issue_draft", &args).unwrap();
    let draft = issue::draft(&args);
    assert_eq!(draft["submission"], "manual");
    assert_eq!(draft["arcBuildVersion"], env!("ARC_BUILD_VERSION"));
    assert_eq!(draft["os"], std::env::consts::OS);
    assert_eq!(draft["summaryMode"], "fixed-category");
    let text = draft.to_string();
    for secret in [
        "prompt-secret",
        "account@example.invalid",
        "/Users/",
        "Users\\example",
        "abc-secret",
        "token-secret",
        "private.invalid",
    ] {
        assert!(!text.contains(secret));
    }
    assert_eq!(draft, issue::draft(&args));
}

#[test]
fn ax_history_discloses_access_and_missing_reasons() {
    // Regression: non-owner AX history silently discarded recorded triage reasons and references.
    let mut f = Fixture::new();
    let entry = f.report("Fixture history projection");
    let closed = f.decide(&entry, "wontfix");
    let owned = f.call("ax_list", json!({"id":closed["id"]}));
    assert_eq!(
        owned["entries"][0]["history"]
            .as_array()
            .unwrap()
            .last()
            .unwrap()["detail"]["reason"],
        "Fixture decision"
    );
    assert!(owned["entries"][0]["history"][0]["reasonUnavailable"].is_null());
    assert!(owned["entries"][0]["history"][1]["reasonUnavailable"].is_null());
    // Reproduce a legacy decision recorded without the now-required reason.
    f.store.mutate("ax_triage", &json!({"id":closed["id"],"expectedRevision":closed["revision"],"action":"reopen","requestId":id()}), &f.actor, vec![], f.time).unwrap();
    let legacy = f.call("ax_list", json!({"id":closed["id"]}));
    assert!(legacy["entries"][0]["history"][2]["reasonUnavailable"].is_string());
    f.actor = json!({"type":"source","sourceId":"other"});
    let read = f.call("ax_list", json!({"id":closed["id"]}));
    let history = read["entries"][0]["history"].as_array().unwrap();
    let last = history.last().unwrap();
    assert!(last["detail"].is_null());
    let next = &last["evidenceUnavailable"]["next"];
    assert_eq!(next["via"], "cli");
    assert!(next["op"].is_null());
    assert_eq!(next["command"], "arc cli control ax_list --stdin");
    assert_eq!(next["stdin"], json!({"id":closed["id"]}));
    f.actor = json!({"type":"local-authority"});
    let local = f.call("ax_list", next["stdin"].clone());
    assert_eq!(
        local["entries"][0]["history"][1]["detail"]["reason"],
        "Fixture decision"
    );
}

#[test]
fn ax_short_id_reads_the_unique_entry_and_rejects_ambiguity() {
    // Regression: ax-9d1b45c5 short ids silently returned no AX entries.
    let mut f = Fixture::new();
    let first = f.report("Digest prefix fixture");
    let prefix = string(&first, "id").chars().take(11).collect::<String>();
    assert_eq!(
        f.call("ax_list", json!({"id":prefix}))["entries"][0]["id"],
        first["id"]
    );
    f.report("Another prefix fixture");
    let ambiguous = f.call("ax_list", json!({"id":"ax-"}));
    assert_eq!(ambiguous["error"]["code"], "INVALID_ARGUMENT");
    assert!(string(&ambiguous["error"], "message").contains("full AX id"));
    assert_eq!(ambiguous["next"]["op"], "guide");
}

#[test]
// Contract: invalid AX op arguments expose field, signature and guide recovery in the error payload.
fn ax_invalid_signature() {
    let mut f = Fixture::new();
    let result = f.call("ax_triage", json!({"id":"ax-fixture","expectedRevision":1,"action":"accept","reason":"Fixture"}));
    assert_eq!(result["error"]["code"], "INVALID_ARGUMENTS");
    assert_eq!(result["error"]["field"], "/action");
    assert!(string(&result["error"], "signature").starts_with("ax_triage("));
    assert_eq!(result["error"]["guide"]["arguments"]["args"]["op"], "ax_triage");
}

#[test]
// Regression: digest short AX ids failed in write operations with AX_NOT_FOUND.
fn ax_short_id_writes() {
    let mut f = Fixture::new();
    let first = f.report("Short write fixture");
    let short = &string(&first,"id")[..11];
    let result = f.call("ax_triage", json!({"id":short,"expectedRevision":first["revision"],"action":"wontfix","reason":"Fixture"}));
    assert_eq!(result["entry"]["id"], first["id"]);
    assert_eq!(result["entry"]["status"], "closed");
    let second = f.candidate("short-candidate", "fixture-build");
    let mut candidate = second["entry"].clone();
    if candidate.is_null() { candidate = second; }
    candidate["id"] = json!(&string(&candidate,"id")[..11]);
    assert_eq!(f.decide(&candidate, "confirm")["status"], "open");
    let error = f.call("ax_triage", json!({"id":"ax-","expectedRevision":1,"action":"wontfix","reason":"Fixture"}));
    assert!(string(&error["error"],"message").contains(string(&first,"id")));
}
