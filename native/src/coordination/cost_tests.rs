//! Explicit scale fixture. Run alone with ARC_STATE_DIR pointing inside this lane.
use super::*;
use crate::runtime_metrics::cost::{self, Owner, Reason};

pub(crate) fn counters() -> Value {
    crate::runtime_metrics::snapshot()["cost"].clone()
}
fn delta(before: &Value, after: &Value) -> Value {
    let mut out = json!({});
    for owner in [
        "coordinationObservers",
        "coordinationRead",
        "coordinationGit",
        "coordinationMessages",
        "dispatchQueue",
        "status",
        "receiptProjection",
        "receiptSeed",
        "indexRepair",
    ] {
        for field in [
            "passes",
            "bytesRead",
            "bytesParsed",
            "rowsVisited",
            "recordsChanged",
            "cacheMisses",
        ] {
            out[owner][field] = json!(
                after[owner][field].as_u64().unwrap() - before[owner][field].as_u64().unwrap()
            );
        }
    }
    out
}
fn seed(base: &Path, time: i64) {
    for (directory, count, bytes) in [
        ("dispatches/source", 1484, 2300),
        ("tasks", 485, 4300),
        ("execution", 432, 700),
    ] {
        for n in 0..count {
            save(&base.join(directory).join(format!("{n}.json")), &json!({"requestId":id(),"threadId":format!("thread-{n}"),"state":"completed","result":{"text":"s".repeat(bytes)}})).unwrap();
        }
    }
    for n in 0..44 {
        save(&base.join("send-queue").join(format!("{n}.json")), &json!({"queueId":id(),"threadId":format!("thread-{n}"),"args":{"prompt":"q".repeat(2000)},"state":"completed","sequence":n,"origin":{"sourceId":"synthetic"}})).unwrap();
    }
    for n in 0..1094 {
        let thread = format!("00000000-0000-4000-8000-{n:012}");
        let turn = format!("turn-{n}");
        let state = if n < 261 { "pending" } else { "delivered" };
        let binding = json!({"threadId":thread,"turnId":turn,"sourceId":"synthetic","target":null,"project":"synthetic","createdAt":time-8*86400,"waiting":[],"observation":if (261..313).contains(&n) {json!({"reconciliation":"exhausted"})} else {json!({})},"scopeEnd":if (313..815).contains(&n){json!("ended")}else{Value::Null},"deliveries":[{"key":format!("delivery-{n}"),"target":"","eventId":format!("event-{n}"),"state":"completed","taskState":"completed","status":state,"createdAt":time-8*86400,"finalResponse":"s".repeat(10800)}]});
        save(
            &base
                .join("notifications/tasks")
                .join(format!("{}.json", hash(json!([thread, turn]).to_string()))),
            &binding,
        )
        .unwrap();
    }
    for n in 0..33 {
        let request = format!("10000000-0000-4000-8000-{n:012}");
        save(&base.join(format!("{request}.json")), &json!({"requestId":request,"operation":"send","state":"completed","backendSession":"fixture","result":{"threadId":format!("thread-{n}"),"history":(0..if n==32{256}else{242}).map(|i|json!({"event":i,"text":"synthetic receipt"})).collect::<Vec<_>>()}})).unwrap();
    }
    for n in 0..36 {
        save(&base.join("coordination/observations").join(format!("{n}.json")), &json!({"coordinationPending":[EventInput::new(format!("synthetic-{n}"), EventKind::AppRestarted, vec![ResourceKey::parse("app:installed").unwrap()])],"payload":"s".repeat(2200)})).unwrap();
    }
    let git = base.join("synthetic-repository/.git");
    std::fs::create_dir_all(&git).unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/main\n").unwrap();
    let mut packed = format!("{} refs/heads/main\n", "1".repeat(40));
    for n in 0..3000 {
        packed += &format!("{} refs/tags/synthetic-{n}\n", "2".repeat(40));
    }
    std::fs::write(git.join("packed-refs"), packed).unwrap();
    save(&base.join("coordination/projects.json"), &json!({"observedAt":now(),"projects":[{"id":"synthetic","roots":[{"path":base.join("synthetic-repository")}]}]})).unwrap();
    save(
        &base.join("task-settings.json"),
        &json!({"notificationsEnabled":true,"requestRoutingDelaySeconds":3}),
    )
    .unwrap();
    save(&base.join("desktop-session.json"), &json!(["synthetic"])).unwrap();
    save(
        &base.join("ingresses/synthetic/config.json"),
        &json!({"id":"synthetic","enabled":true,"transport":"http","name":"Synthetic ingress"}),
    )
    .unwrap();
    save(
        &base.join("ui-preferences.json"),
        &json!({"values":{"theme":"system"},"imported":true}),
    )
    .unwrap();
}
async fn poll(reader: &mut git_watch::RefReader, service: &crate::service::Service, time: i64) {
    cost::sync(Owner::CoordinationObservers, Reason::Timer, || {
        for n in 0..36 {
            let path = root()
                .join("coordination/observations")
                .join(format!("{n}.json"));
            observers::project_at(&path, &path.with_extension("checkpoint"), &|input| {
                Ok(json!({"eventId":input.transition_id}))
            })
            .unwrap();
        }
        bulletin::scale_poll(time).unwrap();
    });
    cost::sync(Owner::CoordinationGit, Reason::Timer, || {
        let common = reader.common(&root().join("synthetic-repository")).unwrap();
        assert_eq!(reader.refs(&common).unwrap().len(), 1);
    });
    cost::sync(Owner::CoordinationRead, Reason::Poll, || {
        crate::claude_notify::governance_scale_status(time).unwrap();
        messages::scale_poll(time).unwrap();
    });
    cost::sync(Owner::CoordinationMessages, Reason::Timer, || {
        messages::scale_poll(time).unwrap()
    });
    crate::dispatch_queue::scale_poll().unwrap();
    let status = service.status().await.unwrap();
    assert_eq!(status["ingresses"].as_array().unwrap().len(), 1);
    let store = crate::kernel::receipts::ReceiptStore::new("");
    for n in 0..33 {
        store
            .read_for_projection(&format!("10000000-0000-4000-8000-{n:012}"), "fixture")
            .unwrap();
    }
}
fn event_history(time: i64) {
    for n in 0..24 {
        with_journal(|j| {
            j.emit(
                EventInput::new(
                    format!("fixture-event-{n}"),
                    EventKind::AppRestarted,
                    vec![ResourceKey::parse("app:installed").unwrap()],
                ),
                time * 1000,
            )
        })
        .unwrap();
    }
    for rebuild in [false, true] {
        if rebuild {
            *JOURNAL.lock().unwrap() = None;
        }
        let reader = journal::Reader {
            principal: Principal::LocalAuthority,
            revision: "fixture".into(),
        };
        let first = with_journal(|j| {
            j.query(
                &reader,
                journal::Query {
                    since: None,
                    resource: None,
                    kinds: None,
                    limit: Some(5),
                },
                time * 1000,
            )
        })
        .unwrap();
        let mut cursor = first["oldestCursor"].as_str().unwrap().to_owned();
        let mut ids = std::collections::BTreeSet::new();
        loop {
            let page = with_journal(|j| {
                j.query(
                    &reader,
                    journal::Query {
                        since: Some(cursor),
                        resource: None,
                        kinds: None,
                        limit: Some(5),
                    },
                    time * 1000,
                )
            })
            .unwrap();
            for event in page["events"].as_array().unwrap() {
                ids.insert(string(event, "eventId").to_owned());
            }
            if page["hasMore"] != true {
                break;
            }
            cursor = page["nextCursor"].as_str().unwrap().to_owned();
        }
        assert_eq!(ids.len(), 24);
    }
}
fn fixture() -> (PathBuf, i64) {
    let base = root();
    assert_eq!(
        base,
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("target/d2d-scale/state")
    );
    assert!(!base.exists(), "use a fresh fixture directory");
    let time = chrono::Utc::now().timestamp();
    assert_eq!(
        std::env::var_os("CODEX_HOME").map(PathBuf::from),
        Some(base.parent().unwrap().join("native-home"))
    );
    seed(&base, time);
    crate::service::scale_seed().unwrap();
    crate::sources::initialize().unwrap();
    messages::scale_seed(time).unwrap();
    bulletin::scale_seed(time).unwrap();
    (base, time)
}
#[tokio::test]
#[ignore = "Installed-shape fixture; run explicitly in a disposable lane-local ARC_STATE_DIR"]
async fn d2d_installed_shape() {
    // Regression: installed near-idle owners repeatedly parsed retained bindings and traversed queue, Git and receipt history.
    let (base, time) = fixture();
    let mut reader = git_watch::RefReader::default();
    let service = crate::service::Service::new().unwrap();
    let initial = counters();
    poll(&mut reader, &service, time).await;
    let cold = counters();
    for n in 1..=3 {
        poll(&mut reader, &service, time + n).await;
    }
    let idle = counters();
    let mut queue = crate::load(&base.join("send-queue/0.json")).unwrap();
    queue["state"] = json!("queued");
    save(&base.join("send-queue/0.json"), &queue).unwrap();
    let binding = base.join("notifications/tasks").join(format!(
        "{}.json",
        hash(json!(["00000000-0000-4000-8000-000000000000", "turn-0"]).to_string())
    ));
    let mut row = crate::load(&binding).unwrap();
    row["title"] = json!("Changed synthetic binding");
    save(&binding, &row).unwrap();
    poll(&mut reader, &service, time + 4).await;
    let changed = counters();
    messages::scale_history(time + 4).unwrap();
    bulletin::scale_history(time + 4).unwrap();
    ax::scale_history(time + 4).unwrap();
    event_history(time + 4);
    let before_rebuild = counters();
    crate::kernel::receipts::scale_rebuild(&base).unwrap();
    let rebuilt = counters();
    let result = json!({"cold":delta(&initial,&cold),"unchanged3":delta(&cold,&idle),"changed1":delta(&idle,&changed),"receiptRebuild":delta(&before_rebuild,&rebuilt)});
    println!("D2D_METRICS {result}");
    save(&base.parent().unwrap().join("metrics.json"), &result).unwrap();
    {
        for owner in [
            "coordinationObservers",
            "coordinationRead",
            "coordinationGit",
            "coordinationMessages",
            "dispatchQueue",
            "status",
            "receiptProjection",
        ] {
            assert_eq!(result["unchanged3"][owner]["bytesParsed"], 0, "{owner}");
        }
        for owner in [
            "coordinationObservers",
            "dispatchQueue",
            "receiptProjection",
        ] {
            assert_eq!(result["unchanged3"][owner]["rowsVisited"], 0, "{owner}");
        }
    }
}
