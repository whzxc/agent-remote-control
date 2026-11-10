use super::*;
use std::{fs::OpenOptions, io::Write, path::PathBuf};

struct Fixture {
    dir: PathBuf,
    store: Option<Journal>,
    time: i64,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!("arc-coordination-{}", id()));
        let time = 1_800_000_000_000;
        let store = Some(Journal::open(dir.clone(), time).unwrap());
        Self { dir, store, time }
    }
    fn emit(&mut self, n: usize, resource: &str) -> Result<Value> {
        self.time += 20; // fixtures stay within the internal 100/second admission budget
        self.store
            .as_mut()
            .unwrap()
            .emit(input(n, resource), self.time)
    }
    fn query(&mut self, args: Value) -> Value {
        self.as_reader(&source_reader("one", "a"), args)
    }
    fn as_reader(&mut self, reader: &Reader, args: Value) -> Value {
        let catalog = catalog();
        let spec = catalog["ops"]
            .as_array()
            .unwrap()
            .iter()
            .find(|v| v["name"] == "events")
            .unwrap();
        crate::egress::validate_op(spec, &args).unwrap();
        let query = serde_json::from_value(args.clone()).unwrap();
        let value = self
            .store
            .as_mut()
            .unwrap()
            .query(reader, query, self.time)
            .unwrap_or_else(|message| failure(message, &args));
        crate::egress::tool_value(&crate::egress::tool(project_coverage(value), false)).unwrap()
    }
    // Seed a bounded snapshot for capacity boundaries. Tests still cross
    // the boundary through emit and assert only the events op, avoiding tens of
    // thousands of fsyncs merely to prepare a full fixture.
    fn seed(&mut self, count: usize, rich: bool) {
        self.store = None;
        let path = self.dir.join("manifest.json");
        let mut manifest = load(&path).unwrap();
        let mut segment = Vec::new();
        let mut first = 1;
        let mut sequence = 1;
        let mut total = 0;
        let mut segments = Vec::new();
        for n in 0..count {
            self.time += 20;
            let mut event = input(n, "app:installed");
            if rich {
                event.evidence_refs = (0..8)
                    .map(|_| EvidenceRef {
                        kind: EvidenceKind::Receipt,
                        id: "a".repeat(128),
                    })
                    .collect();
            }
            let mut bytes =
                serde_json::to_vec(&json!({"sequence":sequence,"time":self.time,"input":event}))
                    .unwrap();
            bytes.push(b'\n');
            if total + bytes.len() > 15 * 1024 * 1024 {
                break;
            }
            if segment.len() + bytes.len() > 256 * 1024 {
                save_bytes(&self.dir.join(format!("{first:020}.jsonl")), &segment).unwrap();
                segments.push(first);
                first = sequence;
                segment.clear();
            }
            total += bytes.len();
            segment.extend(bytes);
            sequence += 1;
        }
        if !segment.is_empty() {
            save_bytes(&self.dir.join(format!("{first:020}.jsonl")), &segment).unwrap();
            segments.push(first);
        }
        manifest["segments"] = json!(segments);
        manifest["next"] = json!(sequence);
        save(&path, &manifest).unwrap();
        self.restart();
    }
    fn restart(&mut self) {
        self.store = None;
        self.store = Some(Journal::open(self.dir.clone(), self.time).unwrap());
    }
    fn partial_tail(&mut self) {
        self.store = None;
        // Fault injection, not an assertion about internal file layout.
        let path = std::fs::read_dir(&self.dir)
            .unwrap()
            .map(|e| e.unwrap().path())
            .filter(|p| p.extension().is_some_and(|e| e == "jsonl"))
            .max()
            .unwrap();
        OpenOptions::new()
            .append(true)
            .open(path)
            .unwrap()
            .write_all(b"{\"sequence\":")
            .unwrap();
        self.restart();
    }
    fn lose_epoch(&mut self) {
        self.store = None;
        std::fs::remove_dir_all(&self.dir).unwrap();
        self.restart();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.store = None;
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}
fn source_reader(source: &str, account: &str) -> Reader {
    reader(&json!({"sourceId":source,"accountId":account,"ingressId":format!("ingress-{source}"),"authType":"oauth"}),
        &json!({"id":source,"ingressId":format!("ingress-{source}"),"state":"connected","credential":{"type":"oauth-grant","grantId":format!("grant-{source}")}})).unwrap()
}
fn input(n: usize, resource: &str) -> EventInput {
    let mut input = EventInput::new(
        format!("transition-{n}"),
        EventKind::DispatchAccepted,
        vec![ResourceKey::parse(resource).unwrap()],
    );
    input.origin = Some(Principal::Source {
        source_id: if n % 2 == 0 { "one" } else { "two" }.into(),
        account_id: Some(if n % 2 == 0 { "a" } else { "b" }.into()),
    });
    input
}
fn sequences(value: &Value) -> Vec<u64> {
    value["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["sequence"].as_u64().unwrap())
        .collect()
}

#[test]
fn events_shape_and_frozen_query_catalog() {
    // Contract: events is a read-only op behind query and returns bounded metadata with replay cursors.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let result = f.query(json!({}));
    for key in [
        "events",
        "nextCursor",
        "hasMore",
        "oldestCursor",
        "coverage",
        "observedAt",
        "arcVersion",
    ] {
        assert!(result.get(key).is_some(), "{key}");
    }
    assert_eq!(result["events"][0]["provenance"], "arc-observed");
    assert!(result["events"][0]["summary"].as_str().unwrap().len() <= 240);
    assert!(!result["events"][0]["summary"]
        .as_str()
        .unwrap()
        .contains('\n'));
    assert_eq!(result["coverage"]["retainedEvents"], 1);
    let catalog = catalog();
    let op = catalog["ops"]
        .as_array()
        .unwrap()
        .iter()
        .find(|op| op["name"] == "events")
        .unwrap();
    assert_eq!(op["annotations"]["readOnlyHint"], true);
    assert!(!crate::validator("test", "events", &op["inputSchema"])
        .unwrap()
        .is_valid(&json!({"origin":{"sourceId":"two"}})));
}
#[test]
fn cursor_pages_without_omissions_while_appending_and_filtering() {
    // Contract: events cursors are exclusive and hold a high-water mark until the retained page cycle completes.
    let mut f = Fixture::new();
    let start = f.query(json!({"resource":"app:installed"}))["oldestCursor"].clone();
    for n in 0..7 {
        f.emit(
            n,
            if n % 2 == 0 {
                "app:installed"
            } else {
                "host:machine"
            },
        )
        .unwrap();
    }
    let first = f.query(json!({"since":start,"limit":2,"resource":"app:installed"}));
    assert_eq!(sequences(&first), vec![1, 3]);
    assert_eq!(first["hasMore"], true);
    f.emit(7, "app:installed").unwrap();
    let second = f.query(json!({"since":first["nextCursor"],"limit":2,"resource":"app:installed"}));
    assert_eq!(sequences(&second), vec![5, 7]);
    assert_eq!(second["hasMore"], false);
    let third = f.query(json!({"since":second["nextCursor"],"resource":"app:installed"}));
    assert_eq!(sequences(&third), vec![8]);
    f.emit(8, "host:machine").unwrap();
    let empty = f.query(json!({"since":third["nextCursor"],"resource":"app:installed"}));
    assert_eq!(sequences(&empty), Vec::<u64>::new());
    assert_ne!(empty["nextCursor"], third["nextCursor"]);
    f.emit(9, "app:installed").unwrap();
    let last = f.query(json!({"since":empty["nextCursor"],"resource":"app:installed"}));
    assert_eq!(sequences(&last), vec![10]);
}
#[test]
fn cursor_and_idempotent_projection_survive_restart() {
    // Contract: persisted event identity, cursor scope and transition replay survive Core restart.
    let mut f = Fixture::new();
    let first = f.emit(0, "app:installed").unwrap();
    let page = f.query(json!({}));
    f.restart();
    let replay = f.emit(0, "app:installed").unwrap();
    assert_eq!(first["eventId"], replay["eventId"]);
    assert_eq!(replay["duplicate"], true);
    f.emit(1, "app:installed").unwrap();
    let next = f.query(json!({"since":page["nextCursor"]}));
    assert_eq!(sequences(&next), vec![2]);
    assert_eq!(
        f.emit(0, "host:machine").unwrap_err().split(':').next(),
        Some("COORDINATION_TRANSITION_CONFLICT")
    );
}
#[test]
fn expired_scope_and_epoch_cursors_report_gaps_with_valid_reset_queries() {
    // Contract: retention, epoch reset and changed visibility/filter scopes never silently skip replay.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let cursor = f.query(json!({}))["oldestCursor"].clone();
    let scope = f.query(json!({"since":cursor,"kinds":["ax.created"]}));
    assert_eq!(scope["error"]["code"], "CURSOR_SCOPE_CHANGED");
    let other = f.as_reader(&source_reader("two", "b"), json!({"since":cursor}));
    assert_eq!(other["error"]["code"], "CURSOR_SCOPE_CHANGED");
    f.time += 7 * 24 * 60 * 60 * 1000;
    let expired = f.query(json!({"since":cursor}));
    assert_eq!(expired["error"]["code"], "CURSOR_EXPIRED");
    assert_eq!(expired["coverage"]["state"], "partial");
    let reset = f.query(expired["next"]["args"].clone());
    assert_eq!(sequences(&reset), Vec::<u64>::new());
    f.emit(1, "app:installed").unwrap();
    assert_eq!(
        sequences(&f.query(json!({"since":reset["nextCursor"]}))),
        vec![2]
    );
    f.lose_epoch();
    assert_eq!(
        f.query(json!({"since":cursor}))["error"]["code"],
        "CURSOR_EXPIRED"
    );
}
#[test]
fn partial_tail_preserves_complete_events_and_reports_recovery() {
    // Contract: an interrupted journal tail is quarantined without losing complete records or claiming complete coverage.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let before = f.query(json!({}));
    f.partial_tail();
    let page = f.query(json!({"since":before["oldestCursor"]}));
    assert_eq!(sequences(&page), vec![1]);
    assert_eq!(page["coverage"]["state"], "partial");
    f.emit(1, "app:installed").unwrap();
    f.restart();
    let next = f.query(json!({"since":page["nextCursor"]}));
    assert_eq!(sequences(&next), vec![2]);
    assert_eq!(next["coverage"]["state"], "partial");
}
#[test]
fn oversized_metadata_and_bad_fields_reject_without_affecting_prior_events() {
    // Contract: events never accept arbitrary content fields or over-budget metadata and preserve the last durable history.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let page = f.query(json!({}));
    let mut huge = input(1, "app:installed");
    huge.evidence_refs = (0..16)
        .map(|_| EvidenceRef {
            kind: EvidenceKind::Receipt,
            id: "a".repeat(128),
        })
        .collect();
    assert!(f
        .store
        .as_mut()
        .unwrap()
        .emit(huge, f.time)
        .unwrap_err()
        .starts_with("COORDINATION_CAPACITY"));
    let mut raw = serde_json::to_value(input(2, "app:installed")).unwrap();
    for field in ["prompt", "title", "error", "summary", "notify"] {
        raw[field] = json!("private-content");
        assert!(serde_json::from_value::<EventInput>(raw.clone()).is_err());
        raw.as_object_mut().unwrap().remove(field);
    }
    f.restart();
    assert_eq!(
        sequences(&f.query(json!({"since":page["oldestCursor"]}))),
        vec![1]
    );
    assert_eq!(f.emit(2, "app:installed").unwrap()["sequence"], 2);
}
#[test]
fn cross_account_sources_share_only_projected_metadata_and_revocation_is_checked() {
    // Contract: two authorized accounts see coordination metadata without resource membership, never task content or routing data.
    let mut f = Fixture::new();
    let secret = "private-prompt-title-error-route";
    for (n, source, account) in [(0, "one", "a"), (1, "two", "b")] {
        let origin = json!({"sourceId":source,"accountId":account,"authType":"oauth","ingressId":format!("ingress-{source}"),"sourceLabel":secret,"prompt":secret,"task_title":secret,"error":secret,"notify":{"target":secret}});
        let mut event = input(n, "app:installed");
        event.origin = Principal::from_origin(&origin).unwrap();
        f.store.as_mut().unwrap().emit(event, f.time).unwrap();
    }
    let a = f.as_reader(&source_reader("one", "a"), json!({}));
    let b = f.as_reader(&source_reader("two", "b"), json!({}));
    assert_eq!(a["events"], b["events"]);
    assert_eq!(sequences(&a), vec![1, 2]);
    assert!(!a.to_string().contains(secret));
    assert_eq!(a["events"][1]["origin"]["accountId"], "b");
    assert!(reader(
        &json!({"sourceId":"one","ingressId":"ingress-one","authType":"oauth"}),
        &json!({"id":"one","state":"revoked"})
    )
    .is_err());
    assert_eq!(Principal::from_origin(&Value::Null).unwrap(), None);
    assert_eq!(
        Principal::from_origin(&json!({"authType":"local","ingressId":"local-ui"})).unwrap(),
        Some(Principal::LocalAuthority)
    );
}
#[test]
fn canonical_resources_resolve_parent_and_reject_ambiguous_lanes() {
    // Property: resource projection never confuses duplicate lane names, paths or absent parent identity.
    let mut resources = Resources::default();
    assert!(resources.lane("p1", "fix").is_err());
    resources.project("p1").unwrap();
    resources.project("p2").unwrap();
    let first = resources.lane("p1", "fix").unwrap();
    assert_eq!(resources.resolve("lane:fix").unwrap(), first);
    resources.lane("p2", "fix").unwrap();
    assert!(resources
        .resolve("lane:fix")
        .unwrap_err()
        .starts_with("RESOURCE_AMBIGUOUS"));
    assert_eq!(resources.resolve("lane:p1/fix").unwrap(), first);
    for key in [
        "project:/personal/path/main",
        "host:user@example.test",
        "lane:../fix",
        "isolated:a\nb",
    ] {
        assert!(ResourceKey::parse(key).is_err());
    }
}
#[test]
fn count_and_disk_retention_expire_oldest_cursor_and_remain_restartable() {
    // Contract: journal retention enforces the record/disk budget and signals eviction through the events cursor.
    let mut f = Fixture::new();
    let oldest = f.query(json!({}))["oldestCursor"].clone();
    f.seed(19_999, false);
    for n in 19_999..20_050 {
        f.emit(n, "app:installed").unwrap();
    }
    f.restart();
    let expiry = f.query(json!({"since":oldest}));
    assert_eq!(expiry["error"]["code"], "CURSOR_EXPIRED");
    let newest = f.query(json!({"limit":200}));
    assert!(sequences(&newest).len() <= 200);
    assert_eq!(sequences(&newest).last(), Some(&20_050));
    let reset = f.query(expiry["next"]["args"].clone());
    assert!(sequences(&reset)[0] > 1);
}

#[test]
fn disk_full_append_reserves_sequence_and_retry_recovers_without_duplicates() {
    // Contract: disk-full cannot report an unpersisted event as durable or reuse a torn append sequence.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let page = f.query(json!({}));
    f.store.as_mut().unwrap().fail_append_after = Some(19);
    assert!(f
        .emit(1, "app:installed")
        .unwrap_err()
        .starts_with("COORDINATION_STORAGE"));
    f.restart();
    let recovered = f.query(json!({"since":page["nextCursor"]}));
    assert_eq!(sequences(&recovered), Vec::<u64>::new());
    assert_eq!(recovered["coverage"]["state"], "partial");
    assert_eq!(f.emit(1, "app:installed").unwrap()["sequence"], 3);
    f.restart();
    let after = f.query(json!({"since":page["nextCursor"]}));
    assert_eq!(sequences(&after), vec![3]);
    assert_eq!(after["coverage"]["gaps"], recovered["coverage"]["gaps"]);
}

#[test]
fn byte_bound_evicts_before_count_bound_and_pages_fit_wire_budget() {
    // Contract: events enforces byte retention and page wire budgets independently of the record-count bound.
    let mut f = Fixture::new();
    let oldest = f.query(json!({}))["oldestCursor"].clone();
    f.seed(14_000, true);
    let before = f.query(json!({}));
    let initial = before["coverage"]["retainedEvents"].as_u64().unwrap();
    for n in 14_000..14_005 {
        f.time += 20;
        let mut event = input(n, "app:installed");
        event.evidence_refs = (0..8)
            .map(|_| EvidenceRef {
                kind: EvidenceKind::Receipt,
                id: "a".repeat(128),
            })
            .collect();
        f.store.as_mut().unwrap().emit(event, f.time).unwrap();
    }
    f.restart();
    let page = f.query(json!({"limit":200}));
    assert!(page["coverage"]["retainedBytes"].as_u64().unwrap() < 16 * 1024 * 1024);
    assert!(page["coverage"]["retainedEvents"].as_u64().unwrap() < 14_000);
    assert!(serde_json::to_vec(&page).unwrap().len() <= 128 * 1024);
    assert_eq!(sequences(&page).last(), Some(&(initial + 5)));
    assert_eq!(
        f.query(json!({"since":oldest}))["error"]["code"],
        "CURSOR_EXPIRED"
    );
}

#[test]
fn account_attribution_changes_do_not_change_source_cursor_authority() {
    // Contract: account reassignment cannot merge source authority or invalidate unchanged coordination visibility.
    let mut f = Fixture::new();
    f.emit(0, "app:installed").unwrap();
    let before = f.as_reader(&source_reader("one", "a"), json!({}));
    f.emit(1, "app:installed").unwrap();
    let after = f.as_reader(
        &source_reader("one", "b"),
        json!({"since":before["nextCursor"]}),
    );
    assert_eq!(sequences(&after), vec![2]);
    let mut changed = source_reader("one", "b");
    changed.revision = "changed-credential".into();
    assert_eq!(
        f.as_reader(&changed, json!({"since":after["nextCursor"]}))["error"]["code"],
        "CURSOR_SCOPE_CHANGED"
    );
}

#[test]
fn admission_budgets_bound_reads_and_emissions_without_losing_retry_scope() {
    // Contract: pull and emission limits fail explicitly, preserve the retry cursor and count coverage loss without queued events.
    let mut f = Fixture::new();
    let first = f.query(json!({"kinds":["ax.created"]}));
    let args = json!({"since":first["nextCursor"],"kinds":["ax.created"]});
    for _ in 0..9 {
        assert!(f.query(args.clone())["error"].is_null());
    }
    let limited = f.query(args.clone());
    assert_eq!(limited["error"]["code"], "COORDINATION_RATE_LIMIT");
    assert_eq!(limited["next"]["args"], args);
    for n in 0..100 {
        f.store
            .as_mut()
            .unwrap()
            .emit(input(n, "app:installed"), f.time)
            .unwrap();
    }
    assert!(f
        .store
        .as_mut()
        .unwrap()
        .emit(input(100, "app:installed"), f.time)
        .unwrap_err()
        .starts_with("COORDINATION_RATE_LIMIT"));
    let other = f.as_reader(&source_reader("two", "b"), json!({}));
    assert_eq!(other["coverage"]["dropped"], 1);
    f.restart();
    let replay = f.query(json!({}));
    assert_eq!(replay["coverage"]["dropped"], 1);
    assert_eq!(replay["coverage"]["retainedEvents"], 100);
}

#[test]
fn expired_lane_shorthand_cursor_resets_to_its_canonical_parent() {
    // Contract: expiration of a lane's last event still returns CURSOR_EXPIRED and a usable canonical reset query.
    let mut f = Fixture::new();
    f.emit(0, "lane:p1/fix").unwrap();
    let page = f.query(json!({"resource":"lane:fix"}));
    f.time += 7 * 24 * 60 * 60 * 1000;
    let expired = f.query(json!({"resource":"lane:fix","since":page["oldestCursor"]}));
    assert_eq!(expired["error"]["code"], "CURSOR_EXPIRED");
    assert_eq!(expired["next"]["args"]["resource"], "lane:p1/fix");
    let reset = f.query(expired["next"]["args"].clone());
    assert_eq!(sequences(&reset), Vec::<u64>::new());
}

fn observer_events(owner: observers::Owner, row: Value) -> Vec<EventInput> {
    observers::inputs_on(owner, &row, ResourceKey::parse("host:fixture").unwrap()).unwrap()
}
fn emit_observation(f: &mut Fixture, input: EventInput) {
    f.time += 20;
    f.store.as_mut().unwrap().emit(input, f.time).unwrap();
}
#[test]
fn observed_dispatch_and_all_terminal_states_are_metadata_only() {
    // Contract: events projects submitted dispatch metadata and observed terminal states without task content.
    let mut f = Fixture::new();
    let row = json!({"requestId":"request-one","threadId":"thread-one","turnId":"turn-one","model":"fixture-model","effort":"high","origin":{"sourceId":"source-one","accountId":"account-one"},"title":"secret-title","prompt":"secret-prompt"});
    for event in observer_events(observers::Owner::Dispatch, row.clone()) {
        emit_observation(&mut f, event);
    }
    for state in ["completed", "failed", "interrupted", "cancelled"] {
        let mut terminal = row.clone();
        terminal["turnId"] = json!(state);
        terminal["terminal"] = json!({"state":state});
        for event in observer_events(observers::Owner::Dispatch, terminal)
            .into_iter()
            .filter(|v| v.kind == EventKind::TurnTerminal)
        {
            emit_observation(&mut f, event);
        }
    }
    let result = f.query(json!({}));
    let events = result["events"].as_array().unwrap();
    assert_eq!(events.len(), 5);
    assert_eq!(events[0]["status"], "submitted");
    assert_eq!(events[0]["origin"]["sourceId"], "source-one");
    assert_eq!(events[0]["observation"]["model"], "fixture-model");
    assert_eq!(events[0]["observation"]["effort"], "high");
    for (event, state) in
        events[1..]
            .iter()
            .zip(["completed", "failed", "interrupted", "cancelled"])
    {
        assert_eq!(event["status"], state);
    }
    assert!(!result.to_string().contains("secret-"));
}

#[test]
fn lifecycle_receipt_and_restart_kinds_are_queryable() {
    // Contract: events exposes each observer kind through the same frozen query envelope and kind filters.
    let mut f = Fixture::new();
    let kinds = [
        EventKind::ReceiptStalled,
        EventKind::ReceiptUnconfirmed,
        EventKind::LaneCreated,
        EventKind::LaneLanded,
        EventKind::LaneRemoved,
        EventKind::IsolatedStarted,
        EventKind::IsolatedExited,
        EventKind::AppRestarted,
    ];
    for (index, kind) in kinds.iter().enumerate() {
        let mut input = EventInput::new(
            format!("observed-{index}"),
            kind.clone(),
            vec![ResourceKey::parse("host:fixture").unwrap()],
        );
        input.origin = Some(Principal::Arc);
        emit_observation(&mut f, input);
    }
    for kind in kinds {
        let result = f.query(json!({"kinds":[kind]}));
        assert_eq!(result["events"].as_array().unwrap().len(), 1);
        assert_eq!(result["events"][0]["kind"], json!(kind));
        assert_eq!(result["events"][0]["provenance"], "arc-observed");
    }
}
#[test]
fn owner_checkpoint_replay_survives_restart_and_journal_retention() {
    // Contract: events deduplicates an uncheckpointed append after restart and a checkpoint prevents replay after retention.
    use std::cell::RefCell;
    let f = RefCell::new(Fixture::new());
    let scratch = ObserverScratch::new();
    let directory = scratch.0.clone();
    let owner = directory.join("transition.json");
    let checkpoint = directory.join("checkpoint.json");
    let input = observer_events(
        observers::Owner::Receipt,
        json!({"requestId":"request-one","state":"unconfirmed"}),
    )
    .remove(0);
    observers::durable(&owner, &json!({"coordinationPending":[input]})).unwrap();
    emit_observation(&mut f.borrow_mut(), input); // Crash after append, before producer checkpoint.
    f.borrow_mut().restart();
    let emit = |input| {
        let mut f = f.borrow_mut();
        f.time += 20;
        let time = f.time;
        f.store.as_mut().unwrap().emit(input, time)
    };
    observers::project_at(&owner, &checkpoint, &emit).unwrap();
    assert_eq!(
        f.borrow_mut().query(json!({}))["events"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    f.borrow_mut().time += 8 * 24 * 60 * 60 * 1000;
    f.borrow_mut().restart();
    observers::project_at(&owner, &checkpoint, &emit).unwrap();
    assert!(f.borrow_mut().query(json!({}))["events"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn git_attribution_is_correlated_only_with_one_matching_turn_interval() {
    // Contract: events reports ambiguous or unknown attribution when turn baseline evidence is not unique or continuous.
    let mut f = Fixture::new();
    let common = Path::new("/fixture/repository");
    let oid = "a".repeat(40);
    let row = json!({"threadId":"thread-one","turnId":"turn-one","commonDir":common,"ref":"refs/heads/main","head":oid,"capturedAt":"2026-01-01T00:00:00Z"});
    let cases = [
        (vec![row.clone()], true, "correlated"),
        (vec![row.clone(), row.clone()], true, "ambiguous"),
        (vec![], true, "unknown"),
        (vec![row.clone()], false, "unknown"),
    ];
    for (index, (rows, continuous, expected)) in cases.into_iter().enumerate() {
        let mut input = EventInput::new(
            format!("correlation-{index}"),
            EventKind::GitRefMoved,
            vec![ResourceKey::project("fixture").unwrap()],
        );
        input.attribution = Some(git_watch::correlate(
            &rows,
            common,
            "refs/heads/main",
            Some(&oid),
            "2026-01-01T00:00:01Z",
            continuous,
        ));
        emit_observation(&mut f, input);
        let result = f.query(json!({"kinds":["git.ref-moved"],"limit":1}));
        assert_eq!(result["events"][0]["attribution"]["confidence"], expected);
    }
    let mut ended = row.clone();
    ended["endedAt"] = json!("2026-01-01T00:00:00Z");
    let attribution = git_watch::correlate(
        &[ended],
        common,
        "refs/heads/main",
        Some(&oid),
        "2026-01-01T00:00:01Z",
        true,
    );
    assert!(matches!(
        attribution.confidence,
        AttributionConfidence::Unknown
    ));
}

fn fixture_git(directory: &Path, args: &[&str]) -> String {
    let result = std::process::Command::new("git")
        .args([
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "-C",
        ])
        .arg(directory)
        .args(args)
        .output()
        .unwrap();
    assert!(result.status.success(), "fixture Git failed");
    String::from_utf8(result.stdout).unwrap().trim().into()
}
#[tokio::test]
async fn registered_refs_report_creation_movement_deletion_and_non_fast_forward() {
    // Contract: events preserves registered ref old/new objects and never attributes restart gaps to a thread.
    let fixture = std::sync::Mutex::new(Fixture::new());
    let directory = fixture.lock().unwrap().dir.join("git-fixture");
    std::fs::create_dir_all(&directory).unwrap();
    fixture_git(&directory, &["init", "-b", "main"]);
    fixture_git(&directory, &["commit", "--allow-empty", "-m", "fixture"]);
    let first = fixture_git(&directory, &["rev-parse", "HEAD"]);
    let store = fixture.lock().unwrap().dir.join("watcher-fixture");
    let emit = |input| {
        let mut f = fixture.lock().unwrap();
        f.time += 20;
        let time = f.time;
        f.store.as_mut().unwrap().emit(input, time)
    };
    let mut watcher = git_watch::Watcher::default();
    watcher
        .scan_in("fixture", "fixture", &directory, &store, &emit)
        .await
        .unwrap();
    fixture_git(&directory, &["branch", "wt/example"]);
    watcher
        .scan_in("fixture", "fixture", &directory, &store, &emit)
        .await
        .unwrap();
    fixture_git(&directory, &["commit", "--allow-empty", "-m", "next"]);
    let next = fixture_git(&directory, &["rev-parse", "HEAD"]);
    watcher
        .scan_in("fixture", "fixture", &directory, &store, &emit)
        .await
        .unwrap();
    fixture_git(&directory, &["update-ref", "refs/heads/main", &first]);
    watcher = git_watch::Watcher::default(); // Movement happened while the observer was down.
    watcher
        .scan_in("fixture", "fixture", &directory, &store, &emit)
        .await
        .unwrap();
    fixture_git(&directory, &["branch", "-D", "wt/example"]);
    watcher
        .scan_in("fixture", "fixture", &directory, &store, &emit)
        .await
        .unwrap();
    let result = fixture
        .lock()
        .unwrap()
        .query(json!({"kinds":["git.ref-moved"]}));
    let events = result["events"].as_array().unwrap();
    assert_eq!(events.len(), 4);
    for (event, movement) in events
        .iter()
        .zip(["created", "moved", "non-fast-forward", "deleted"])
    {
        assert_eq!(event["observation"]["movement"], movement);
    }
    assert_eq!(events[1]["observation"]["oldOid"], first);
    assert_eq!(events[1]["observation"]["newOid"], next);
    assert_eq!(events[2]["attribution"]["confidence"], "unknown");
    assert_eq!(events[0]["resources"][0], "lane:fixture/example");
}
#[test]
fn unchanged_git_polls_open_no_files_or_directories() {
    // Regression: 2f77284 and 9e956a0 bounded idle polling; ref observation must not reopen unchanged files per poll.
    let fixture = Fixture::new();
    let directory = fixture.dir.join("git-cache-fixture");
    std::fs::create_dir_all(&directory).unwrap();
    fixture_git(&directory, &["init", "-b", "main"]);
    fixture_git(&directory, &["commit", "--allow-empty", "-m", "fixture"]);
    fixture_git(&directory, &["branch", "wt/example"]);
    fixture_git(&directory, &["pack-refs", "--all"]);
    let mut reader = git_watch::RefReader::default();
    let common = reader.common(&directory).unwrap();
    let initial = reader.refs(&common).unwrap();
    let budget = (reader.opens, reader.directory_opens);
    for _ in 0..20 {
        assert_eq!(reader.refs(&common).unwrap(), initial);
    }
    assert_eq!((reader.opens, reader.directory_opens), budget);
}

struct ObserverScratch(PathBuf);
impl ObserverScratch {
    fn new() -> Self {
        Self(std::env::temp_dir().join(format!("arc-observer-fixture-{}", id())))
    }
}
impl Drop for ObserverScratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[tokio::test]
async fn unreachable_registered_roots_surface_coverage_without_fabricated_ref_events() {
    // Contract: events exposes unreachable registered-project coverage without inventing ref movements.
    let scratch = ObserverScratch::new();
    let mut watcher = git_watch::Watcher::default();
    watcher
        .poll_registered(&[json!({"id":"unreachable-fixture","roots":[{"path":scratch.0}]})])
        .await;
    let mut fixture = Fixture::new();
    let page = fixture.query(json!({"kinds":["git.ref-moved"]}));
    assert!(page["events"].as_array().unwrap().is_empty());
    assert_eq!(
        page["coverage"]["observers"]["unreachable-fixture-0"]["state"],
        "unreachable-or-ref-capacity"
    );
}

#[test]
fn stalled_receipt_is_phase_age_not_task_failure() {
    // Contract: events records progressStalled at 30 seconds without claiming execution failure or duplicating a phase.
    let mut f = Fixture::new();
    let row =
        json!({"requestId":"slow-request","state":"reserved","updatedAt":types::timestamp(f.time)});
    let resource = ResourceKey::parse("host:fixture").unwrap();
    assert!(
        observers::stalled_input(&row, f.time + 29_999, resource.clone())
            .unwrap()
            .is_none()
    );
    let first = observers::stalled_input(&row, f.time + 30_000, resource.clone())
        .unwrap()
        .unwrap();
    let retry = observers::stalled_input(&row, f.time + 60_000, resource.clone())
        .unwrap()
        .unwrap();
    emit_observation(&mut f, first);
    emit_observation(&mut f, retry);
    let result = f.query(json!({"kinds":["receipt.stalled"]}));
    assert_eq!(result["events"].as_array().unwrap().len(), 1);
    assert!(result["events"][0]["status"].is_null());
    assert_eq!(result["events"][0]["evidenceRefs"][0]["id"], "slow-request");
    let mut done = row;
    done["state"] = json!("completed");
    assert!(observers::stalled_input(&done, f.time + 60_000, resource)
        .unwrap()
        .is_none());
}

#[test]
fn agent_dispatch_requires_observed_transport_submission() {
    // Contract: events distinguishes a prepared Agent dispatch from a prompt frame actually submitted to its transport.
    let row = json!({"agent":"fixture-agent","requestId":"agent-request","threadId":"agent-task","turnId":"agent-turn","submission":"pending","model":"fixture-model"});
    assert!(observer_events(observers::Owner::Dispatch, row.clone()).is_empty());
    let mut submitted = row;
    submitted["submissionObserved"] = json!(true);
    let mut f = Fixture::new();
    for input in observer_events(observers::Owner::Dispatch, submitted) {
        emit_observation(&mut f, input);
    }
    let page = f.query(json!({"kinds":["dispatch.accepted"]}));
    assert_eq!(page["events"].as_array().unwrap().len(), 1);
    assert_eq!(page["events"][0]["status"], "submitted");
    assert_eq!(page["events"][0]["threadRefs"][0]["turnId"], "agent-turn");
}

#[tokio::test]
async fn git_catalog_recovers_after_startup_and_watches_main_and_lanes() {
    // Regression: installed Core retained project-catalog-unavailable after a successful upstream registry read.
    let fixture = std::sync::Mutex::new(Fixture::new());
    let dir = fixture.lock().unwrap().dir.clone();
    let repository = dir.join("repository");
    std::fs::create_dir_all(&repository).unwrap();
    fixture_git(&repository, &["init", "-b", "main"]);
    fixture_git(&repository, &["commit", "--allow-empty", "-m", "initial"]);
    fixture_git(&repository, &["branch", "wt/example"]);
    let catalog = dir.join("registered.json");
    let store = dir.join("observed");
    let emit = |input| {
        let mut f = fixture.lock().unwrap();
        f.time += 20;
        let time = f.time;
        f.store.as_mut().unwrap().emit(input, time)
    };
    let mut watcher = git_watch::Watcher::default();
    watcher.poll_in(&catalog, &store, &emit).await;
    let page = fixture.lock().unwrap().query(json!({}));
    assert_eq!(
        page["coverage"]["observers"]["git"]["state"],
        "project-catalog-unavailable"
    );
    let mut registered: Value =
        serde_json::from_str(include_str!("fixtures/project-catalog.json")).unwrap();
    registered["projects"][0]["roots"][0]["path"] = json!(repository);
    save(&catalog, &registered).unwrap();
    watcher.poll_in(&catalog, &store, &emit).await;
    let page = fixture.lock().unwrap().query(json!({}));
    assert!(page["events"].as_array().unwrap().is_empty());
    assert_eq!(page["coverage"]["observers"]["git"]["state"], "observed");
    assert_eq!(
        page["coverage"]["observers"]["git"]["lastGap"]["state"],
        "project-catalog-unavailable"
    );
    assert_eq!(
        page["coverage"]["observers"]["projectRegistry"]["observedAt"],
        registered["observedAt"]
    );
    fixture_git(&repository, &["commit", "--allow-empty", "-m", "next"]);
    fixture_git(&repository, &["branch", "-f", "wt/example", "main"]);
    watcher.poll_in(&catalog, &store, &emit).await;
    watcher.poll_in(&catalog, &store, &emit).await;
    let page = fixture
        .lock()
        .unwrap()
        .query(json!({"kinds":["git.ref-moved"]}));
    let events = page["events"].as_array().unwrap();
    assert_eq!(events.len(), 2);
    assert_eq!(
        events[0]["resources"],
        json!(["project:fixture-project/main"])
    );
    assert_eq!(
        events[1]["resources"],
        json!(["lane:fixture-project/example"])
    );
    for event in events {
        assert_eq!(event["observation"]["movement"], "moved");
        assert_eq!(event["attribution"]["confidence"], "unknown");
        assert_eq!(event["attribution"]["threadIds"], json!([]));
    }
}

#[test]
fn historical_receipts_preserve_unknown_origins_and_skip_invalid_records_individually() {
    // Regression: installed historical OAuth receipts with empty sourceId marked the entire receipts observer invalid-metadata.
    let fixture = std::sync::Mutex::new(Fixture::new());
    let resource = ResourceKey::parse("host:fixture").unwrap();
    let rows: Vec<Value> =
        serde_json::from_str(include_str!("fixtures/receipt-metadata.json")).unwrap();
    let time = chrono::DateTime::parse_from_rfc3339("2026-01-01T00:01:00Z")
        .unwrap()
        .timestamp_millis();
    let persist = |input| {
        emit_observation(&mut fixture.lock().unwrap(), input);
        Ok(())
    };
    let mut observer = observers::ReceiptObserver::default();
    // Keep the historical shapes, including missing createdAt and empty sourceId;
    // reopen completed fixture phases to exercise the same observer conversion.
    for (index, row) in rows.iter().enumerate() {
        let mut row = row.clone();
        row["state"] = json!("reserved");
        row["backendSession"] = json!("new-session");
        let path = PathBuf::from(format!("receipt-{index}"));
        observer.observe(&path, &row, "new-session", time, resource.clone(), &persist);
    }
    observer.report();
    let page = fixture
        .lock()
        .unwrap()
        .query(json!({"kinds":["receipt.stalled"],"limit":100}));
    let events = page["events"].as_array().unwrap();
    assert_eq!(events.len(), rows.len());
    for (event, row) in events.iter().zip(&rows) {
        let origin = &row["origin"];
        if origin["authType"] == "local"
            && matches!(string(origin, "ingressId"), "local-cli" | "local-ui")
        {
            assert_eq!(event["origin"]["type"], "local-authority");
        } else if string(origin, "sourceId").is_empty() {
            assert!(event["origin"].is_null());
        } else {
            assert_eq!(event["origin"]["sourceId"], origin["sourceId"]);
            assert_eq!(event["origin"]["accountId"], origin["accountId"]);
        }
    }
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["skippedInvalidRecords"],
        0
    );
    let mut invalid = rows[0].clone();
    invalid["state"] = json!("reserved");
    invalid["origin"] = json!({"sourceId": ["invalid"]});
    let bad_path = Path::new("bad-receipt");
    for _ in 0..3 {
        observer.observe(
            bad_path,
            &invalid,
            "new-session",
            time,
            resource.clone(),
            &persist,
        );
    }
    let mut valid = rows[0].clone();
    valid["requestId"] = json!("valid-after-invalid");
    valid["state"] = json!("reserved");
    valid["backendSession"] = json!("new-session");
    observer.observe(
        Path::new("valid-receipt"),
        &valid,
        "new-session",
        time,
        resource.clone(),
        &persist,
    );
    observer.report();
    let page = fixture
        .lock()
        .unwrap()
        .query(json!({"kinds":["receipt.stalled"],"limit":100}));
    assert_eq!(page["events"].as_array().unwrap().len(), rows.len() + 1);
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["state"],
        "observed"
    );
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["skippedInvalidRecords"],
        1
    );
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["invalidCountCapped"],
        false
    );
    valid["requestId"] = json!("repaired-receipt");
    observer.observe(
        bad_path,
        &valid,
        "new-session",
        time,
        resource.clone(),
        &persist,
    );
    observer.report();
    assert_eq!(
        fixture.lock().unwrap().query(json!({}))["coverage"]["observers"]["receipts"]
            ["skippedInvalidRecords"],
        0
    );
    invalid["origin"] = Value::Null;
    invalid["updatedAt"] = json!("invalid-time");
    for index in 0..4100 {
        observer.observe(
            &PathBuf::from(format!("invalid-{index}")),
            &invalid,
            "new-session",
            time,
            resource.clone(),
            &persist,
        );
    }
    observer.report();
    let page = fixture.lock().unwrap().query(json!({}));
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["state"],
        "observed"
    );
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["skippedInvalidRecords"],
        4096
    );
    assert_eq!(
        page["coverage"]["observers"]["receipts"]["invalidCountCapped"],
        true
    );
}

#[test]
fn executing_command_is_not_a_stalled_submission() {
    // Regression: AX-07 healthy foreground commands emitted receipt-stalled candidates after 30 seconds.
    let mut f = Fixture::new();
    let row = json!({"requestId":"foreground","operation":"command","state":"executing","updatedAt":types::timestamp(f.time)});
    for state in ["executing", "awaiting-approval", "unconfirmed"] {
        let mut receipt = row.clone();
        receipt["state"] = json!(state);
        assert!(observers::stalled_input(
            &receipt,
            f.time + 300_000,
            ResourceKey::parse("host:fixture").unwrap(),
        ).unwrap().is_none());
    }
    assert!(f.query(json!({"kinds":["receipt.stalled"]}))["events"]
        .as_array()
        .unwrap()
        .is_empty());
    let result = crate::egress::receipt(row);
    assert_eq!(result["progressStalled"], false);
}
