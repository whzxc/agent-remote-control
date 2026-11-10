//! Fixed-cardinality work accounting. Nested owners attribute I/O to the innermost scope.
use super::*;
use std::{cell::Cell, future::Future};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Owner {
    IndexUpdate,
    NotificationAdopt,
    ReceiptAdopt,
    NotificationSeed,
    ReceiptSeed,
    IndexRepair,
    NotificationObserver,
    NotificationDelivery,
    TaskRecords,
    AgentTaskRecords,
    ReceiptProjection,
    TaskFeed,
    TaskList,
    DispatchQueue,
    CoordinationObservers,
    CoordinationGit,
    CoordinationMessages,
    RuntimeLease,
    Ingress,
    Relay,
    Subscriptions,
    McpSweep,
    DesktopSnapshots,
    AgentProcess,
    Status,
    Activity,
    Accounts,
    TaskRead,
    CoordinationRead,
    RoutingRead,
    EnvironmentRead,
    RelayJobRead,
    BrowserGuard,
    WaitHeartbeat,
    ScopedWait,
    DraftExpiry,
}
const OWNERS: [&str; 36] = [
    "indexUpdate",
    "notificationAdopt",
    "receiptAdopt",
    "notificationSeed",
    "receiptSeed",
    "indexRepair",
    "notificationObserver",
    "notificationDelivery",
    "taskRecords",
    "agentTaskRecords",
    "receiptProjection",
    "taskFeed",
    "taskList",
    "dispatchQueue",
    "coordinationObservers",
    "coordinationGit",
    "coordinationMessages",
    "runtimeLease",
    "ingress",
    "relay",
    "subscriptions",
    "mcpSweep",
    "desktopSnapshots",
    "agentProcess",
    "status",
    "activity",
    "accounts",
    "taskRead",
    "coordinationRead",
    "routingRead",
    "environmentRead",
    "relayJobRead",
    "browserGuard",
    "waitHeartbeat",
    "scopedWait",
    "draftExpiry",
];
#[derive(Clone, Copy)]
pub(crate) enum Reason {
    Startup,
    Timer,
    Event,
    Dirty,
    Deadline,
    Poll,
}
const REASONS: [&str; 6] = ["startup", "timer", "event", "dirty", "deadline", "poll"];
struct Cost {
    passes: AtomicU64,
    wakes: [AtomicU64; 6],
    rows: AtomicU64,
    changed: AtomicU64,
    read: AtomicU64,
    parsed: AtomicU64,
    hits: AtomicU64,
    misses: AtomicU64,
    scan_set: AtomicU64,
    retained: AtomicU64,
    observed: AtomicU64,
    dormant: AtomicU64,
}
impl Cost {
    const fn new() -> Self {
        Self {
            passes: AtomicU64::new(0),
            wakes: [const { AtomicU64::new(0) }; 6],
            rows: AtomicU64::new(0),
            changed: AtomicU64::new(0),
            read: AtomicU64::new(0),
            parsed: AtomicU64::new(0),
            hits: AtomicU64::new(0),
            misses: AtomicU64::new(0),
            scan_set: AtomicU64::new(0),
            retained: AtomicU64::new(0),
            observed: AtomicU64::new(0),
            dormant: AtomicU64::new(0),
        }
    }
}
static COSTS: [Cost; 36] = [const { Cost::new() }; 36];
tokio::task_local! { static OWNER: Owner; }
thread_local! { static SYNC_OWNER: Cell<Option<Owner>> = const { Cell::new(None) }; }
pub(crate) fn current() -> Option<Owner> {
    SYNC_OWNER.get().or_else(|| OWNER.try_with(|o| *o).ok())
}
fn update(f: impl FnOnce(&Cost)) {
    if let Some(owner) = current() {
        f(&COSTS[owner as usize]);
    }
}
fn begin(owner: Owner, reason: Reason) {
    if current() != Some(owner) {
        let c = &COSTS[owner as usize];
        c.passes.fetch_add(1, Relaxed);
        c.wakes[reason as usize].fetch_add(1, Relaxed);
    }
}
// Box before constructing the async block. An async fn would retain the inline
// input in its initial state even if its body boxed that input on the first poll.
pub(crate) fn scope<T>(
    owner: Owner,
    reason: Reason,
    future: impl Future<Output = T>,
) -> impl Future<Output = T> {
    let future = Box::pin(future);
    async move {
        begin(owner, reason);
        OWNER.scope(owner, future).await
    }
}
pub(crate) fn sync<T>(owner: Owner, reason: Reason, work: impl FnOnce() -> T) -> T {
    begin(owner, reason);
    struct Restore(Option<Owner>);
    impl Drop for Restore {
        fn drop(&mut self) {
            SYNC_OWNER.set(self.0);
        }
    }
    let _restore = Restore(SYNC_OWNER.replace(Some(owner)));
    work()
}
/// Propagate attribution into a child task without counting another pass.
pub(crate) fn inherit<T>(future: impl Future<Output = T>) -> impl Future<Output = T> {
    let owner = current();
    let future = Box::pin(future);
    async move {
        match owner {
            Some(owner) => OWNER.scope(owner, future).await,
            None => future.await,
        }
    }
}
pub(crate) fn blocking<T>(work: impl FnOnce() -> T) -> impl FnOnce() -> T {
    let owner = current();
    move || {
        struct Restore(Option<Owner>);
        impl Drop for Restore {
            fn drop(&mut self) {
                SYNC_OWNER.set(self.0);
            }
        }
        let _restore = Restore(SYNC_OWNER.replace(owner));
        work()
    }
}
pub(crate) fn read_scope<T>(
    route: &str,
    method: &str,
    future: impl Future<Output = T>,
) -> impl Future<Output = T> {
    let future = Box::pin(future);
    let owner = match route {
        "tasks/request-routing" | "tasks/presence" => Some(Owner::RoutingRead),
        "app/env" => Some(Owner::EnvironmentRead),
        "coordination/board"
        | "coordination/events"
        | "coordination/messages"
        | "coordination/ax_list"
        | "coordination/conflicts" => Some(Owner::CoordinationRead),
        _ if route.starts_with("relay/") && method == "GET" => Some(Owner::RelayJobRead),
        _ if route.starts_with("tasks/") && (method == "GET" || route.ends_with("timeline")) => {
            Some(Owner::TaskRead)
        }
        _ => None,
    };
    async move {
        match owner {
            Some(owner) => {
                scope(owner, Reason::Poll, async {
                    scan_set(1);
                    future.await
                })
                .await
            }
            None => future.await,
        }
    }
}
pub(crate) fn op_scope<T>(op: &str, future: impl Future<Output = T>) -> impl Future<Output = T> {
    let future = Box::pin(future);
    let owner = match op {
        "codex_read" | "task_timeline" | "task_reviews" | "codex_review" | "dispatch_policy"
        | "agent_read" | "agent_review" | "receipt" => Some(Owner::TaskRead),
        "board" | "events" | "messages" | "ax_list" => Some(Owner::CoordinationRead),
        "app_env" => Some(Owner::EnvironmentRead),
        _ => None,
    };
    async move {
        match owner {
            Some(owner) => {
                scope(owner, Reason::Poll, async {
                    scan_set(1);
                    future.await
                })
                .await
            }
            None => future.await,
        }
    }
}
/// Timers can wake within a long-lived input pass without starting another pass.
pub(crate) fn wake(reason: Reason) {
    update(|c| {
        c.wakes[reason as usize].fetch_add(1, Relaxed);
    });
}
pub(crate) fn rows(count: usize) {
    update(|c| {
        c.rows.fetch_add(count as u64, Relaxed);
    });
}
pub(crate) fn changed(count: usize) {
    update(|c| {
        c.changed.fetch_add(count as u64, Relaxed);
    });
}
pub(crate) fn bytes_read(count: usize) {
    update(|c| {
        c.read.fetch_add(count as u64, Relaxed);
    });
}
pub(crate) fn bytes_parsed(count: usize) {
    update(|c| {
        c.parsed.fetch_add(count as u64, Relaxed);
    });
}
pub(crate) fn cache(hit: bool) {
    update(|c| {
        if hit { &c.hits } else { &c.misses }.fetch_add(1, Relaxed);
    });
}
pub(crate) fn scan_set(count: usize) {
    update(|c| c.scan_set.store(count as u64, Relaxed));
}
pub(crate) fn bindings(retained: usize, observed: usize, dormant: usize) {
    update(|c| {
        c.retained.store(retained as u64, Relaxed);
        c.observed.store(observed as u64, Relaxed);
        c.dormant.store(dormant as u64, Relaxed);
    });
}
pub(super) fn snapshot() -> Value {
    Value::Object(OWNERS.iter().zip(&COSTS).map(|(name, c)| ((*name).into(), json!({
        "passes":c.passes.load(Relaxed),
        "wakesByReason":REASONS.iter().zip(&c.wakes).map(|(name,c)|((*name).into(),json!(c.load(Relaxed)))).collect::<serde_json::Map<_,_>>(),
        "rowsVisited":c.rows.load(Relaxed), "recordsChanged":c.changed.load(Relaxed),
        "bytesRead":c.read.load(Relaxed), "bytesParsed":c.parsed.load(Relaxed),
        "cacheHits":c.hits.load(Relaxed), "cacheMisses":c.misses.load(Relaxed),
        "scanSetSize":c.scan_set.load(Relaxed),
        "bindings":if *name == "notificationObserver" { json!({"retained":c.retained.load(Relaxed),"observed":c.observed.load(Relaxed),"dormant":c.dormant.load(Relaxed)}) } else { Value::Null }
    }))).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn attribution_wrappers_bound_future_size() {
        // Regression: D2a inline attribution futures overflowed the default Tokio worker stack in unoptimized Core startup.
        fn payload() -> impl Future<Output = usize> {
            let bytes = [0u8; 64 * 1024];
            async move {
                std::future::ready(()).await;
                std::hint::black_box(bytes.as_slice()).len()
            }
        }
        let scoped = scope(Owner::BrowserGuard, Reason::Poll, payload());
        let inherited = inherit(payload());
        let read = read_scope("app/env", "GET", payload());
        let op = op_scope("app_env", payload());
        let other_read = read_scope("other", "GET", payload());
        let other_op = op_scope("other", payload());
        let nested = scope(
            Owner::BrowserGuard,
            Reason::Poll,
            inherit(read_scope("app/env", "GET", op_scope("app_env", payload()))),
        );
        for size in [
            std::mem::size_of_val(&scoped),
            std::mem::size_of_val(&inherited),
            std::mem::size_of_val(&read),
            std::mem::size_of_val(&op),
            std::mem::size_of_val(&other_read),
            std::mem::size_of_val(&other_op),
            std::mem::size_of_val(&nested),
        ] {
            assert!(
                size <= 1024,
                "Attribution must not inline a 64 KiB child: {size} bytes"
            );
        }
        assert_eq!(scoped.await, 64 * 1024);
        assert_eq!(inherited.await, 64 * 1024);
        assert_eq!(read.await, 64 * 1024);
        assert_eq!(op.await, 64 * 1024);
        assert_eq!(other_read.await, 64 * 1024);
        assert_eq!(other_op.await, 64 * 1024);
        assert_eq!(nested.await, 64 * 1024);
    }

    #[tokio::test]
    async fn projection_cost_is_content_free_and_shared_reads_are_attributed_once() {
        // Contract: runtime_metrics exposes cumulative owner costs and attributes nested shared reads once without task content.
        struct Fixture(PathBuf);
        impl Drop for Fixture {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(self.0.parent().unwrap());
            }
        }
        let directory = std::env::temp_dir().join(format!("arc-cost-{}", id()));
        std::fs::create_dir(&directory).unwrap();
        let file = Fixture(directory.join("record.json"));
        let bytes = br#"{"fixtureSecret":"private-task-content"}"#;
        std::fs::write(&file.0, bytes).unwrap();
        let control = control::Control::new(PathBuf::new());
        let mut cache = crate::kernel::file_cache::Cache::<Value>::default();
        let before = control.tool("runtime_metrics", json!({})).await.unwrap();
        for _ in 0..2 {
            scope(Owner::TaskRecords, Reason::Poll, async {
                scope(Owner::TaskRecords, Reason::Poll, async {
                    sync(Owner::ReceiptProjection, Reason::Poll, || {
                        scan_set(1);
                        cache.read(&file.0).unwrap();
                    });
                })
                .await;
            })
            .await;
        }
        sync(Owner::ReceiptProjection, Reason::Poll, || {
            save_bytes(&file.0, b"{}").unwrap();
        });
        let after = control.tool("runtime_metrics", json!({})).await.unwrap();
        let delta = |owner: &str, key: &str| {
            after["cost"][owner][key].as_u64().unwrap()
                - before["cost"][owner][key].as_u64().unwrap()
        };
        assert_eq!(delta("taskRecords", "passes"), 2);
        assert_eq!(delta("receiptProjection", "rowsVisited"), 2);
        assert_eq!(delta("receiptProjection", "bytesRead"), bytes.len() as u64);
        assert_eq!(
            delta("receiptProjection", "bytesParsed"),
            bytes.len() as u64
        );
        assert_eq!(delta("receiptProjection", "cacheMisses"), 1);
        assert_eq!(delta("receiptProjection", "cacheHits"), 1);
        assert_eq!(delta("receiptProjection", "recordsChanged"), 1);
        assert_eq!(delta("taskRecords", "bytesRead"), 0);
        assert!(!after.to_string().contains("private-task-content"));
        assert!(!after.to_string().contains(file.0.to_str().unwrap()));
        println!(
            "runtime_metrics projection fixture: {}",
            after["cost"]["receiptProjection"]
        );
    }
}
