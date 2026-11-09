# Runtime invariants roadmap

Status: proposed; awaiting user review

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

## Scope and boundaries

ARC distributes correctness across string-valued lifecycle projections, regression cases and control-source instructions. The proposed direction is correctness by construction: one evidence-aware turn transition function, activity-bounded scheduling, independent ingress and execution lifetimes, and decision-ready Agent surfaces backed by mechanisms. Existing caches, typed coordination events and detached executors are foundations, not replacements for these invariants.

The user decides before implementation. Each proposed increment below is independently compilable and landable. This proposal changes no runtime contract. The frozen `guide`/`query`/`act` parameter structures, `notification` event and `{op,args}` subscription envelope remain unchanged. CLI JSON envelopes, error contracts and existing wire status strings remain unchanged. Catalog operations can acquire documented projections behind those boundaries.

Agent runtimes retain canonical sessions, transcripts and history indexes in native storage. ARC stores only its operation receipts, associations, coordination state and bounded derived observations. The `poll-cost` lane owns accounts revision recomputation; this roadmap consumes that result. No UI redesign, automatic task resubmission, new Agent authority, release gate or public service is proposed.

## Current implementation and runtime evidence

Source anchors below are relative to `native/src/` unless linked otherwise. Function names identify ownership rather than incidental line numbers. [Architecture](architecture.md), [terminology](terminology.md), [control-plane proposal](control-plane-proposal.md) and current source define the boundaries.

| AX reference | Relevant evidence and interpretation |
| --- | --- |
| `ax-0d9fb1f7-cbc8-4acc-832e-6e34a22f58e8`, `ax-3040e3c7-c35a-4025-8994-4a65b05a24c1` | Open reports of an interrupted push followed by `codex_read` showing a completed native turn. They motivate shared evidence precedence, without identifying one proven root cause. |
| `AX-07` | Open, with prior fix/verification and a later automatic reopen for receipt stalls. Operation execution progress and native turn outcome need separate models. |
| `ax-733879c7-ef48-44e8-9f00-7d442dc6fe4c`, `ax-090844fd-fa90-44db-a604-d978e6f94a92` | Open reports of history-sized observer work and unexplained Core CPU. Zero retirements in an observation window does not mean retirement code is absent. |
| `AX-04` | Closed `wontfix` because reconnect failure was not reproducible in the recorded checks; no fixing commit was identified. It does not promise uninterrupted MCP sessions. |
| `ax-6cbc54cb-2e99-414a-8a0e-d54c5e6a1d64`, `ax-b691c0e3-1b0e-4a15-9688-b3de57a397a8` | Open restart/interruption reports. The latter requests automatic continuation, which is a separate policy choice from preserving execution. |
| `ax-9d1b45c5-a302-4823-b88b-23769b5cb74a` | Open report that overflowing list results produce an unusable raw prefix. `kernel/results.rs::page_output` actually caps the prefix at 2048 **UTF-8 bytes**, backs off to a character boundary, and reports UTF-16 continuation offsets. |

## D1. Typed turn lifecycle authority

### Inventory and corrected premise

More than 25 native modules derive, compare or emit turn/task status. There is no shared turn-lifecycle enum or transition authority. `coordination/types.rs::EventStatus` already types event projections, including terminal values; “no status enum exists” would be incorrect. Operation state, delivery state, thread runtime state, tool-item state and turn state are distinct domains even when their strings coincide.

The following inventory covers production status decision/projection sites, including consumers that do not invent outcomes. Test fixtures and provider/login/update state machines are excluded. Multiple functions sharing one evidence boundary occupy one row.

| File and function anchors | Evidence read → result derived, compared or emitted |
| --- | --- |
| [waiter.rs](../../native/src/waiter.rs): `classify`, `finish`, `observe`, `codex_notification_observe`, `wait`, `condition`, `deadline_result`, `compact_response` | Selected native turn, runtime owner and pending interactions → running/terminal/interaction/unconfirmed, wait termination and response eligibility. Native terminal precedes runtime uncertainty here. |
| [control.rs](../../native/src/control.rs): `dispatch_state`, `perform`, `tool_inner`, `recent_timeline`, `request_inner`, `profile_rpc_running`, `release_writer` | Native thread/turns, owner locks and receipts → dispatch/resume/steer admission, read projection, timeline start and idle-server policy. Writer release has a separate operation outcome. |
| [task_tracking.rs](../../native/src/task_tracking.rs): `record_turn_status`, `finish`, `agent`, `codex`, `observe`, `put`, `sync_interactions`, `backfill_codex_with_metadata` | Protocol events and historical turns → string-valued timeline/turn map and terminal latch; `put` also prevents late item activity reopening a terminal turn. `tool`, `codex_item`, `chunk`, `delta`, `resolve`, `answered`, `error`, `session` project item/interaction state, not independent turn verdicts. |
| [task_tracking/transcripts.rs](../../native/src/task_tracking/transcripts.rs): `backfill_codex_records`, `backfill_claude`, `transcript_active` | Native rollout completion/abort and Claude transcript evidence → terminal/activity metadata. |
| [task_tracking/antigravity.rs](../../native/src/task_tracking/antigravity.rs): `Timeline::antigravity` | Native event names → shared timeline converters and lifecycle events. |
| [agents/process.rs](../../native/src/agents/process.rs): `terminal_status`, `observe`, `replayed_write`, `replayed_response`, `antigravity_event`, `release` | Native replies, settled events, journal replay and host exit record → running/completed/failed/cancelled; missing exit evidence → unknown. An exit record currently can settle a previously nonterminal task. |
| [agents/driver.rs](../../native/src/agents/driver.rs): `start`, `prompt`, `interrupt`, `respond` | Driver replies, submission errors and local interrupt intent → idle/running/cancelling/cancelled/failed/unknown and receipt outcomes. Pi interrupt currently writes cancelled before later native reconciliation. |
| [agents/wait.rs](../../native/src/agents/wait.rs): `AgentSource::classify`, `final_response` | Task snapshot, process identity, selected turn and interactions → wait state and final-message eligibility. |
| [agents/mod.rs](../../native/src/agents/mod.rs): `task_records`, `activity`, `task`, `cancel_account`, `close`, `tool`, `perform`, `launch` | Persisted task plus live driver → runtime projection, active-task selection, archive/control admission and operation receipts. |
| [agents/activity.rs](../../native/src/agents/activity.rs): `tail`, `observe_clock`, `codex_sessions` | Transcript clock and live timeline → active/inactive session metadata and rescanning decisions. |
| [agents/conversations.rs](../../native/src/agents/conversations.rs): `stored`, `conversations`, `conversation_timeline` | ARC task snapshot and native metadata → merged conversation status and selected timeline status. |
| [agents/conversations/native.rs](../../native/src/agents/conversations/native.rs): `antigravity_timeline` | Upstream ACTIVE/DONE/ERROR states → timeline running/completed/failed. |
| [agents/archive.rs](../../native/src/agents/archive.rs): `archive` | Task lifecycle and pending interactions → archive eligibility. |
| [claude_notify.rs](../../native/src/claude_notify.rs): `transitions`, `process`, `recover`, `resumed`, `start`, `empty_answered_completion`, `enrich_completion`, `event`, `glyph` | Wait observations, restart state and successor evidence → terminal binding, notification events and presentation; cancelled maps to interrupted. `expired`, `remove_expired`, `flush`, `wakes`, `inbox_wait` consume scope/delivery state. |
| [claude_notify/observer.rs](../../native/src/claude_notify/observer.rs): `reusable`, `ownership_needed`, `Idle::capture`, `exhausted`, `unavailable` | Binding outcome, reconciliation attempts, file stamps and thread cursor → reuse, owner discovery and reconciliation state, not new native terminal evidence. |
| [claude_notify/continuation.rs](../../native/src/claude_notify/continuation.rs): `notice_state`, `adopt` | Later native turns and predecessor observations → successor association, continuation state and recovery window. |
| [claude_notify/retry.rs](../../native/src/claude_notify/retry.rs): `safe_turn`, `handle` | Confirmed failed turn, capacity error and activity → bounded retry eligibility and successor receipt. |
| [claude_notify/ownership.rs](../../native/src/claude_notify/ownership.rs): `observe` | Writer handoffs → unconfirmed ownership event, not terminal execution. |
| [claude_notify/mcp_events.rs](../../native/src/claude_notify/mcp_events.rs): `list`; [claude_notify/governance.rs](../../native/src/claude_notify/governance.rs): `status_in` | Binding/event schemas and delivery state → notification continuation enums and status projections. |
| [dispatch_policy.rs](../../native/src/dispatch_policy.rs): `terminal_snapshot`, `complete`, `agent_observe`, `select_review_turn`, `select_agent_review`, `review`, `summarize_history`, `summarize_packs` | Native terminal or task snapshot and review → durable terminal summary, review admission and outcome aggregates. `decision.rs::history` compacts those aggregates. |
| [dispatch_queue.rs](../../native/src/dispatch_queue.rs): `control`, `tick` | Current native turn and original submission receipt → queue eligibility, blocked/dispatching/steered/failed/unconfirmed queue state. |
| [task_overview.rs](../../native/src/task_overview.rs): `compact`, `list`, `display_record`, `list_records` | Native runtime, latest turn, queue and receipt metadata → task-list state/actions; runtime-first ordering differs from `waiter::classify`. |
| [task_summary.rs](../../native/src/task_summary.rs): `evidence` | Wait/read state → terminal evidence and complete-result links. |
| [changes.rs](../../native/src/changes.rs): `is_terminal`, `query`, `review_evidence`, `terminal` | Selected native turn → capture/read eligibility for Git evidence. |
| [desktop.rs](../../native/src/desktop.rs): `check_steer`; [desktop/interactions.rs](../../native/src/desktop/interactions.rs): `respond` | Desktop turn and interaction replies → steer eligibility and preservation of terminal evidence. |
| [lib.rs](../../native/src/lib.rs): `pending_interactions`; [execution.rs](../../native/src/execution.rs): `call` | Recorded turn/interaction and wait result → pending interaction filtering and automatic observation. |
| [egress.rs](../../native/src/egress.rs): `interrupted_turn`, `outcome_error`, `receipt`, `next` | Operation versus turn context → error projection, unchanged wire values and next action. |
| [transport.rs](../../native/src/transport.rs): `dispatch` | Wait cancellation → unconfirmed read result; no evidence of interruption. |
| [coordination/observers.rs](../../native/src/coordination/observers.rs): `status`, `terminal`, `inputs_on`, `receipt_inputs`, `stalled_input` | Dispatch/task/receipt checkpoints → typed events, terminal observations and stall candidates. |
| [coordination/bulletin/mod.rs](../../native/src/coordination/bulletin/mod.rs): `linked`, `apply_link_observations`, `from_event`, `tick`; [store.rs](../../native/src/coordination/bulletin/store.rs): `observe`, `maintain`, `project` | Linked turns/events → running/completed/interrupted/unknown scope; failed execution counts as completed work scope, not successful work. |
| [coordination/recovery.rs](../../native/src/coordination/recovery.rs): `obsolete`, `select`, `affected` | Terminal/successor events → recovery candidates and obsolete suppression. |

Adjacent operation-state sites also belong in the migration boundary: `kernel/receipts.rs::{normalize,failure_state}`, `control.rs::{mutate,launch,decide,close}`, `agents/process.rs::recover_receipt`, `operations.rs::{submit,read}`, `service.rs::request`, `control_metrics.rs::{finish,Drop::drop}`, `diagnostics.rs::receipts`, `external_inputs.rs::{submitted,response_failed}`, and coordination `{ax,bulletin,messages}/mod.rs::{call,failure}` reserve, finish, normalize or inspect operation receipts. `coordination/ax/store.rs::verification_reasons` checks completed verification receipts. Delivery statuses in notify `{subscriptions,scheduler,governance,reachability,coordination_delivery}` and `coordination/messages/store.rs` stay separate. `review.rs::native_files` compares file-change item status; `setup.rs::{loop_evidence,loop_status}` consumes setup evidence. None should be mechanically converted into `TurnState` because it contains the word completed.

### Model

Use an internal `TurnKey { agent, native_session, turn_id }` and a single `advance(previous, evidence) -> Transition`. Only protocol adapters construct native evidence. Proposed types:

```rust
enum TurnState { Unconfirmed, Active, AwaitingInteraction, Terminal(TerminalRecord) }
enum Outcome { Completed, Failed, Interrupted }
enum Evidence { NativeTerminal(TerminalRecord), OwnerLive(LiveRecord), Loss(LossRecord) }
// State retains the selected key, native sequence when available, evidence and revision.
// TerminalRecord construction requires an explicit native turn outcome.
```

Evidence strength is `NativeTerminal > OwnerLive > Loss`. Strength is a partial order within one turn, not an ordering of completed versus failed. At equal strength, native sequence/revision resolves freshness when available; contradictory terminal evidence without that ordering retains a conflict diagnostic and suppresses a new push pending reconciliation. Arrival time alone never overturns a terminal record. A newer turn has a different key.

Terminal knowledge is monotonic: terminal cannot become active, uncertain or a weaker terminal inference. Active and interaction state may change under newer owner evidence; owner loss makes current liveness unconfirmed while preserving the last confirmed observation separately. Thus monotonicity applies to accumulated authoritative knowledge, not a false total order over liveness labels. Weak connection/process evidence yields unconfirmed and never a terminal push. An interrupt request records intent until the native owner confirms interruption. A host exit record proves process exit; adapters must reconcile native turn outcome before constructing `NativeTerminal`.

Operation receipts use a separate typed phase model: reserved, submitting, executing, awaiting approval, settled or unconfirmed. A completed dispatch receipt proves submission, not turn completion. `egress.rs::receipt` already distinguishes executing from stalled submission; AX-07 needs that separation across all operation producers rather than a turn enum rename.

Serialization lives at native adapters and egress. `inProgress` remains the upstream spelling, wait/CLI `cancelled` remains `cancelled`, notification `interrupted` remains `interrupted`, and unknown/unconfirmed stays context-specific. The new type is internal; no new terminal spelling is added to a frozen surface. Existing persisted projections are decoded by their owning adapter, then replaced when rewritten; native history is never migrated into ARC.

### D1 increments and acceptance

| Increment | Independently landable change | Observable acceptance |
| --- | --- | --- |
| D1a | Pure transition function, scoped evidence constructors and explicit wire adapters; initially used by wait classification. | Permuting loss/active evidence around a confirmed terminal produces the same terminal; duplicate evidence has no additional effect; mismatched turn keys cannot affect the selected turn. Existing wait strings remain identical. |
| D1b | Route notification processing, restart reconciliation and delivery admission through the same transition. Remove replaced local terminal predicates. | Push and selected-turn read agree for delayed observations in the two AX terminal reports; loss alone emits no terminal notification; a late predecessor cannot replace successor state. |
| D1c | Adopt in Agent drivers/processes, Timeline and task projections, then policy/queue/coordination consumers. | Pi interruption waits for native confirmation; native completion after Core absence reads and pushes once; late tool deltas leave terminal unchanged; summaries distinguish thread idle from selected-turn completed. |
| D1d | Separate operation progress in all receipt producers and retire obsolete status branches. | A long running command reads executing without a stalled-submission hint; lost submission reads unconfirmed with the original request ID. |

Replace the status-permutation portions of `task_tracking.rs::stream_stability_late_events_do_not_reopen_terminal_turns`, `waiter.rs::failures_disconnect_and_interaction_still_return_immediately`, `task_overview.rs::statuses_are_evidence_based_and_compact_does_not_copy_prompts`, and `claude_notify/observer.rs::reconciliation_exhaustion_preserves_unknown_task_state` with Property coverage of `advance`. Retain their adapter, timeout and projection assertions where those exercise separate behavior. Keep AX delivery/resume regressions (`claude_notify/ax_tests.rs::ax_late_restart_interruption_after_resumed_completion_is_superseded`) and native replay regressions: a pure transition property cannot cover routing, persistence or protocol parsing. No contract test is replaced by a property about implementation internals.

## D2. Cost follows activity, not history

### Current cost inventory

The observer does not scan all bindings on every wake: `observer::Idle::unchanged` can skip a pass, `TerminalWatch` reuses settled/exhausted observations, and `expired`/`remove_expired` retire eligible records. On a non-skipped pass, `claude_notify::start` still builds history-wide path/latest maps and walks all bindings, including unattributed rows before skipping them. An active scope can invalidate the global idle shortcut. `ReceiptStore::read_for_projection` already caches parsed metadata through `file_cache::Cache::read_with`; repeated parsing is a cache-miss/eviction/invalidation question, not unconditional behavior on every task poll.

Cadences below are configured intervals or fallback delays, not measured throughput. Work can lengthen an iteration. H denotes retained history; A denotes live scopes, due deadlines, configured providers or actual subscribers. Startup reconciliation and explicitly requested historical pages are separately budgeted.

| Periodic owner / polled read anchors | Cadence | Per-iteration driver and remaining concern |
| --- | --- | --- |
| `runtime.rs::serve_mode` lease loop / ingress monitor | 500 ms / 5 s | Live leases / configured ingresses (A); status and provider work remain visible even without UI. `runtime::start_heartbeat` is a client-side 2 s lease writer. |
| `ingress.rs::start` supervisor, `https_tunnel.rs` health reads | 2 s; provider recovery backoff 60–300 s | Running providers (A), network probes and indexed children, not task history. |
| `relay/transport.rs::{start,connect}` | 25 s heartbeat; reconnect 1–60 s | Live relay connection and in-flight forwarding (A). |
| `claude_notify.rs::start` observer | Event wake or 2 s after pass | Global idle cache; otherwise H bindings/maps, per-thread writer probes and up to eight concurrent history reads. |
| `claude_notify.rs::start` delivery worker; `scheduler.rs::next_at` | Watch/event or next due deadline; 1 s fallback without valid watches | Cached inputs when idle; invalidation joins bindings/subscriptions/deliveries (H) to due delivery work (A). |
| `dispatch_queue.rs::start`, `records`, `tick` | 1 s | Cached retained queue rows (H), then one active queued/blocked/uncertain submission per thread (A). |
| `coordination/observers.rs::start`, `ReceiptObserver` | Dirty wake or 5 s | Startup bounded owner discovery (H once), dirty files and unsettled receipts (A); `bulletin::tick` scans retained notice links and observes running scopes. |
| `coordination/git_watch.rs::Watcher::{poll,scan_in}` | 5 s with active baselines; otherwise 30 s | Bounded registered roots/refs, stamp-cached reads; Git subprocess work on changes. This configured watch budget is independent of turn history. |
| `coordination/messages/mod.rs::start`, `flush`, store `next_background_at` | 5 s stamp/deadline check | Constant dependency check when unchanged; retained messages, recovery events and bindings when rebuilding (H), then due deliveries (A). |
| `subscriptions/mod.rs::{start,refresh}` | Wake/5 s; inventory 180 s; quota refresh configured minutes/reset/backoff | Configured provider slots and eligible due refreshes (A), upstream requests bounded separately. |
| `mcp_hub.rs::sweeper` | 60 s | Pooled downstream server entries (A/configured pool), close idle connections. |
| `desktop.rs::connect` snapshot pruner | 1 s per connection | Bounded live Desktop snapshots (A); IPC reader itself is event-driven. |
| `agents/process.rs::Frames::next`, `observe` | 100 ms while awaiting detached output; dirty checkpoint within 1 s | Attached task-host status/journal and dirty streaming task (A); includes idle attached hosts until released. |
| `transport.rs::local_request` SSE | Activity 1 s; status/browser 2 s; subscription change/15 s | Per subscriber (A); activity discovery traverses native session metadata (H) with incremental tail caches. Status includes configured services/accounts. |
| `browser.rs::handle` stream guard; `wait_transport.rs::stream` | 2 s / 30 s | Live browser authentication check / pending wait heartbeat (A). |
| `waiter.rs::wait`, `claude_notify.rs::inbox_wait`, `control.rs::tool_inner`, `setup.rs::request` | Event/deadline waits; native retry 2 s, cancellation check 250 ms; inbox fallback 1 s; control pending wait 250 ms; setup bounded deadline | Selected task, source inbox or request (A). Explicit bounded waits terminate with their request. |
| `service.rs::request_inner` draft expiry and stop waits | Draft expiry 30 s; stop check 500 ms | Live draft or requested stop (A); each expiry task exits when its draft is removed. |
| `task_overview.rs::{Feed::read,list}`, `control.rs` task records, `agents/mod.rs::task_records`; UI `state/tasks.ts` | Task snapshot poll 5 s; remote list caller-paced | Revisioned projection with cached receipt metadata; invalidations rebuild retained task/receipt lists (H), then bounded requested page/live probes. |
| `service.rs::status`, `agents/activity.rs::Monitor::sample`; UI `state/{connector,activity,agents}.ts` | Status 2 s; activity fallback 5 s (2 s dev); inventory 15 s, preparing 1.5 s | Configured services/accounts or native-session discovery (H); activity samples reuse a 2 s clock and healthy discovery watches, with a 30 s fallback discovery scan. Overlaps SSE readers. |
| Account/subscription reads; UI `state/{accounts,subscriptions}.ts` | 10 s while consumed / 30 s stream fallback | Configured accounts/providers; accounts revision work belongs to `poll-cost`. |
| Task timeline/read/review/dispatch-policy; UI `state/taskExecution.ts`, `components/SourceDispatches.tsx`, `components/ActivityTimeline.tsx` | Execution/source records 10 s; selected timeline 1 s (5 s preview/read-only/external); other reads caller-paced | Selected native history, dispatch records and policy aggregate history (H); use revision/terminal caches rather than repeated hydration. |
| Board/messages/AX reads; UI `coordination/{state,CoordinationCenter,AXPanel}.tsx` | 15 s and visibility changes | Retained bounded coordination stores (H) plus pagination/projection; digest work must share indexes. |
| Routing, environment and relay-job reads; UI `state/{requestRouting,appEnvironment,relay}.ts` | Routing 1 s, presence sampling 2 s; environment 500 ms; relay job 1 s | Selected request/environment/job (A); presence writes only on changes. Hub panel polls 1 s connecting/15 s otherwise. Account-login UI polls the selected login at 1 s after an initial 300 ms delay; pet review metadata polls selected terminal tasks at 15 s. |

One-shot launch/adoption/readiness/stop loops in `runtime`, `rpc`, `codex_host`, `task_host`, `owned_children`, `headless`, `management`, `uninstall`, `cloudflare`, `https_tunnel`, `desktop/interactions` and provider credential helpers are deadline-bound per operation, not resident history scans. Event-driven socket/stdout/file-watch readers do work on input. Detached `task_host::run` has its own 100 ms liveness/idle tick outside Core. Desktop updater/window timers and renderer animation clocks also remain outside Core's work accounting.

### Invariant, index and retention

For a steady workload, recurring Core work should be bounded by `active scopes + changed records + due deadlines + subscribed projections + configured watches`, independent of retained completed turns. Explicit history reads cost the requested page; initial index construction/recovery costs retained history once with progress and a bounded batch size. A new unrelated turn must not force rehydration of every old binding.

Keep a derived index keyed by turn/source, with separate sets for observing, delivery-due, reconciliation-due, dormant and retention-due records, plus the latest resumable scope per source/thread. Producer changes update the index and wake the affected key. Use a deadline queue rather than scanning history to find due work. A watcher failure triggers bounded repair with an exposed coverage gap; no periodic full-history repair is hidden in normal ticks.

Retirement from observation does not delete a binding. Unattributed bindings remain retained and dormant until attribution or relevant evidence changes. Exhausted reconciliation becomes dormant after the existing attempt budget; explicit read, native/file/owner change or a new successor reactivates it. Settled records leave the observation set. Pending/sending deliveries retain their own schedule even when observation is dormant. The latest interrupted scope stays discoverable for resume regardless of notification quietness; a successor/explicit scope end changes that eligibility. Preserve `expired` exactly: terminal, older than seven days from creation, superseded/continuation-bound/scope-ended, and no pending/sending deliveries. Preserve the existing 50-event source inbox bound. Removing unattributed data or changing retention requires a separate decision.

`runtime_metrics.rs::{Scope,ObservationSample,snapshot}` exposes process CPU and **wall** work timings. The latter overlap and include waits; subtracting their sum from CPU does not establish an uninstrumented CPU percentage. The AX CPU report motivates attribution work, not that arithmetic. Extend existing metrics with index sizes, wakes by reason, rows visited, bytes read/parsed, cache misses, dirty keys, due items and repair batches for the listed owners. Shared scopes must be counted once. Use bounded CPU profiling of Core for CPU attribution; keep process CPU deltas as an independent outcome.

Acceptance compares equal active workloads with small and large retained histories after warmup: recurring scan/read/parse counts stay equal within configured repair work, idle history reads become zero, and CPU does not acquire a history-dependent slope. Then vary active scopes with fixed history to demonstrate proportional work. Expose cold rebuild cost separately. Pending delivery, latest interrupted resume, exhausted reactivation and restart readback must still work. Counters prove work bounds; CPU samples and profiles explain residual cost.

### Storage recommendation and increments

`rusqlite` is already bundled in `native/Cargo.toml`; `archive_index.rs` uses it. SQLite would provide transactional lifecycle/index/outbox updates and indexed due queries, at the cost of a new canonical store, lock/recovery ownership and migration of independent file owners. Files plus a derived index preserve existing receipts and retention, reuse `kernel/file_cache`, and solve the demonstrated hot scans with less migration risk. Recommend files plus an index first. Reconsider SQLite only if measured cross-file consistency or indexed-query cost remains dominant; native history would remain outside either store.

| Increment | Change and observable acceptance |
| --- | --- |
| D2a | Add bounded cost counters around the inventory; the same read exposes process CPU, independent wall timings and work counts without task content. Consume the accounts lane result. |
| D2b | Introduce an in-memory activity/deadline index and indexed receipt summaries, seeded once from canonical files before observation starts; fixed active work has the same recurring row visits after adding retained history. Pending deliveries and dormant wakeups remain reachable. |
| D2c | Persist the derived index with per-key updates and an explicit invalidation/rebuild boundary around incomplete owner writes. One-time migration under the existing Core ownership lock: read retained bindings/receipt metadata in batches, derive latest scopes/deadlines, atomically publish the new index, verify counts and representative pending/resume readback, then remove replaced full-scan paths and any superseded derived snapshots. Normal startup adopts the current index; an invalidated index takes the bounded rebuild path. Canonical receipt/binding files remain current data, not a compatibility copy. Interrupted migration restarts safely before normal observation; no dual-write legacy path survives. |
| D2d | Apply changed-key projections to queue, coordination and caller-polled views; repeated unchanged reads do not parse old payloads, and explicit historical pages remain complete. |

## D3. Stable front door, replaceable Core, detached executors

### Current process boundary

`runtime.rs::serve_mode` owns the Core lock and local listener. `service.rs::Service`, `ingress.rs::{start,start_inner,stop}`, `https.rs::listen`, `https_tunnel.rs::{spawn,stop}` and `owned_children.rs::recover` establish the current lifetime:

```text
Desktop / CLI leases -> Core
                       + local management listener, HTTPS/MCP/OAuth listeners
                       + ingress provider children / relay connection
                       + MCP hub stdio, auth helpers, Codex proxy, direct fallback Agents
detached Codex App Server <- disposable Core proxy
detached task-host -> Pi / ACP / stream-json Agent
```

Core shutdown cancels its listeners/streams, supervisors, observers and owned children. Core replacement therefore interrupts ingress and provider connectivity together. Detached execution is already implemented: `8f06d72`, `31f2059`, `ffc2da2`; current anchors are `codex_host.rs::{spawn,indexed_spawn}`, `rpc.rs::{connect_host,close}`, `task_host.rs::{launch,run}` and `agents/process.rs::{from_host,close}`. Shutdown closes idle executors and disconnects active ones; direct stdio fallback remains Core-bound. Uninstall explicitly stops detached executors. External-token refresh still needs Core, so survival does not imply indefinite disconnected execution. Native history/journals supply reconciliation after reattachment.

### Proposed front door

Create one small Rust front-door process per ARC state directory, independently supervised from Core. It owns listener sockets, ingress identity/configuration, TLS-facing routing, tunnel provider lifecycle, relay links, HTTP/MCP transport sessions and bounded request/stream buffers. Desktop and CLI attach through the stable local endpoint. Core keeps dispatch, task state, accounts, receipt idempotency, coordination, scheduling and business policy. Detached executors keep their existing ownership.

Keep ingress authentication at the front door: OAuth grants/pairing, ingress Bearer/OpenAI checks, browser key/cookie verification and private local-management authentication remain in their current authority domains. Extract the existing modules rather than copy stores. Core validates the authenticated local transport peer and server-derived ingress/source context and applies current operation authorization, task association and resource boundaries. Source revocation propagates to the front door; new admissions pause if current authority cannot be established during a swap. Agent credentials and external-token refresh stay in Core. Request headers cannot choose another ingress or manufacture source identity.

Use a private Unix socket on macOS/Linux and named pipe on Windows. A minimal internal protocol carries a version handshake, Core generation/readiness, authenticated context, request ID/operation/body, response/stream frames, cancellation and drain acknowledgement. Enforce bounded frames, flow control and deadlines. Generation fencing prevents old Core responses or a stale Core from becoming authoritative. The existing Core state lock still permits one business owner. The front door MUST NOT dispatch, replay writes, infer turn completion, store Agent transcripts, choose accounts, restart Agents or implement a second receipt store.

The initial swap contract drains admitted requests to a deadline and pauses new business admissions. Requests not sent to Core may wait in a bounded memory queue within their original deadlines. Reads already sent to the old Core fail explicitly if the connection ends; the caller can retry. Writes already sent return an uncertain result with the original request ID and a receipt-read next action. The front door MUST NOT repeat an ambiguous write. Existing subscriptions may stay transport-connected while Core reattaches; event-gap/expiry semantics remain those of the existing notification owner.

Verified source supports detached executor adoption, durable request-ID replay checks and bounded transport forwarding. Preserving public connections during a Core swap is proposed. Holding an in-flight MCP call across the swap, automatic read retry, downstream client timeout tolerance and event replay across MCP session generations are assumptions requiring focused acceptance. Begin with explicit bounded failure/readback; do not promise transparent completion or exactly-once delivery.

The front door has its own versioned executable and update path. Install the next binary, drain admissions, stop only its provider/listeners, start the new front door and validate readiness; roll back its binary/configuration if startup fails. This maintenance can reconnect clients and does not restart detached executors or require a Core update. Initially permit a bounded front-door outage; socket handoff between front-door versions is an open decision, not a prerequisite. Remove the old Core-owned provider path when ingress ownership moves.

Failure handling: Core crash retains sockets but fails admitted calls as above; front-door crash loses connections and its own provider children, then its supervisor restores them; provider loss uses existing bounded backoff; incompatible Core protocol refuses attachment with an actionable error; full buffers reject new admissions without dropping accepted request identity; failed drain leaves receipt reconciliation available after restart. Core and front-door ownership indexes must remain disjoint so Core recovery cannot reap the surviving provider.

### D3 increments and acceptance

| Increment | Change | Observable acceptance |
| --- | --- | --- |
| D3a | Extract transport/auth adapters behind an internal protocol while keeping existing process placement. | Authorized/unauthorized MCP, browser and local requests have identical behavior; revoked sources cannot gain access through reconnect. |
| D3b | Move listeners/provider supervision into the front door; retain Core lock and detached executor adoption. | Replacing Core preserves listener address/provider process identity and active native turns; the next authorized read reaches the new Core; fallback transport reports its reduced continuity. |
| D3c | Add bounded drain/queue/cancellation and subscription reattachment. | A completed write with a lost response reconciles once by its original receipt; no prompt is resubmitted; timeout and event-gap outcomes are actionable. |
| D3d | Ship supervision and front-door self-update on macOS, Windows and headless Linux x86_64/aarch64. | macOS process sessions, Windows independent jobs/named pipes and Linux user scopes/service restart each preserve active executors during Core replacement; front-door update/recovery reconnects clients and uninstall removes both owners. |

Runtime acceptance runs serially from main with separately assigned scope. Windows replacement must release executable handles; Linux service cgroups must not kill front door or executors with Core; macOS supervision must survive Desktop replacement. Platform claims require each platform's real replacement checks. AX-b691c0e3's automatic-resume expectation remains a user decision; the proposed default preserves execution and reconciles interruption without creating a new turn.

## D4. Agent surface: digests and mechanisms

### Digest contract

`kernel/results.rs::page_output` preserves the full temporary result but gives only raw prefix text, key names and a few identifiers. `dispatch_policy/decision.rs::{present,history}` is the existing compact decision model: native model/configuration choices and grouped outcomes, with stale evidence labeled. Generalize semantic projection before generic result paging, without adding MCP tools.

Initial list operations: `notify_status`, `ax_list`, `codex_tasks`, `agent_tasks`, `dispatch_policy`, `board`, `messages`, `events`, `src_conversations`, `projects`, `mcp_tools` and `codex_thread` list actions. Each owner defines its row meaning and safe counts; detail reads keep their current contracts. Verify the selected operation's catalog projection before dispatching its implementation; no new frozen guide topic is required.

Proposed catalog `view:digest` for dedicated list ops returns `{view, revision, counts, rows, omitted, coverage, next}`. `dispatch_policy` retains `view:decision`; `codex_thread` applies the digest only to its list actions. Counts are labeled exact, bounded or unknown and refer to the authorized filtered set. Rows carry stable opaque IDs, state, a bounded one-line summary and a schema-valid detail action. `notify_status` emphasizes actionable routes/attention, AX severity/state, tasks selected-turn outcome/interactions, board conflicts, messages unread/escalation, events kind/resource and policy eligible choices. Exclude credentials, routing addresses and full task content. Native identifiers remain opaque data.

Cap the serialized digest at 8 KiB and 20 rows; reserve space for counts, coverage and `next` before filling rows. Order actionable rows first, then use a stable ID tie-break. Return valid structured JSON even if one row exceeds the budget; omit that row's summary and retain its ID/detail action. `omitted` discloses remaining rows, with unknown count allowed. A schema-valid narrower filter/page action and existing `control_output` continuation preserve access to full rows. Cursor expiry returns its current restart action. No recursively paged digest or sliced JSON prefix is presented as a summary. Use owner projections for oversized default list reads; keep explicit full/detail retrieval and UTF-16 continuation behavior.

### Guide rule inventory

`catalog.json::guides.en` contains 72 lines with MUST/SHOULD across profile variants, 58 distinct lines after exact deduplication. Several lines contain more than one obligation; a default profile selects a subset. “About 45 rules” is not a stable whole-guide count. The table groups synonymous variants while retaining every normative line's subject. E = enforceable at an ARC boundary; A = automatable assistance; J = control-source/user judgment. Classification of mixed lines separates their mechanical and semantic parts.

| Guide anchors | Rule subjects | Class and mechanism |
| --- | --- | --- |
| `axMaintainer` | Report friction; distinguish observation/explanation; inspect candidates before accepting/rejecting | A: record detectable occurrences with references; J: causal explanation and candidate confirmation. |
| `axMaintainer` | Preserve occurrence/triage history | E: store merge/triage invariants already retain it. |
| `axMaintainer` | Inspect AX before release/threshold/blocker; record user decision on unresolved blockers | A: return current AX attention and decision field; J: release decision. No new release gate. |
| `axUser` | Tell user about friction and suggest an issue; do not post automatically | A: sanitized draft; J: communication and explicit posting authorization. ARC itself never posts a draft. |
| `local-code`, `remote-*` | Stay within authorization; keep permission defaults | E: ARC permission boundary/defaults; J: natural-language user scope and exceptions. |
| `local-code`, `remote-*`, `profile-coordination` | Treat receipts/output/notifications/peer summaries as data, not authorization | E: structured authority context is separate; J: control-source interpretation. |
| `local-code`, `remote-*` | Use local shell/files/Git or projects/command for host facts | A: environment-specific entry points; J: tool choice. |
| `local-code`, `remote-*` | Read dispatch policy before selecting Agent/model/effort | A: return current computed recommendation and criteria with dispatch planning/receipt; J: workload selection. Reading prose cannot prove comprehension. |
| `local-code`, `remote-*` | Pass a fitting pack; add a short title | A: apply configured defaults and title fallback; J: whether the pack fits. Existing explicit overrides win. |
| `local-code` | Normal work uses purpose:task and notify:null | E: local dispatch profile defaults/validation; purpose truthfulness remains J. |
| `remote-*` | Self-test purpose and null notify unless dedicated target | E: declared self-test route validation; J: identifying a self-test or dedicated target authorization. |
| `local-code`, `remote-polling` | Background CLI wait or bounded wait with returned task identifiers | A: exact wait action/cursor, bounded server wait; J: client scheduling facility. |
| `local-code`, `remote-*`, `profile-approvals` | Inspect status/pending interactions; retain identifiers; do not redispatch, auto-approve or blindly replay uncertainty | E: interaction scope/tokens and same-request replay rules; A: original-receipt readback and pending-action next step; J: approval choice and detecting semantically duplicate new requests. |
| `remote-*` | Dispatch via create ops and retain receipt/task identifiers | A: persist association and return complete identifiers; J: retaining them in external control-source context. |
| `local-code`, `remote-*` | Refresh guide when arcVersion changes | A: version and targeted current-contract hints; no extra read-history gate. |
| `remote-*`, `profile-coordination` | Read board/messages and post notice before multi-step/shared-resource work or land/replace/dev:isolated/push | A: derived dispatch notice and receipt conflict projection; J: non-ARC intent/resources and resolving advisory conflicts. |
| `profile-notify` | Read notify schema; derive Claude target from its environment or ask user; bind returned notify; bind Antigravity target | A: schema-valid binding and environment-derived target when available; J: intended conversation selection. |
| `profile-notify` | Acknowledge only a received code; do not claim delivery without reachability | E: challenge and route verification; J: control source attests actual destination receipt. |
| `profile-notify` | Read referenced task after notification; schedule revisit or bounded wait without reachability | A: selected-turn digest/detail action and revisit hint; J: external revisit scheduling. |
| `profile-coordination` | Register only verified source-owned push target; keep session open while push is wanted | E: ownership/verification; A: live dispatch association retains eligibility; J: explicit session-close intent. |
| `profile-src` | Inspect source bindings; read schema before import/change | A: binding digest/current-contract hints; E: operation validation; J: choosing correct upstream login/binding. |
| `profile-context` | Resolve configured context; retain upstream evidence/attribution; search/read details | A: context resolution and linked detail actions; E: preserve returned provenance; J: which evidence answers the task. |
| `local-code`, `remote-*`, `profile-review` | Inspect completed turn, changes, validation and terminal/interactions before verdict | E: terminal-turn admission; A: evidence digest; J: adequacy of checks and pass/rework verdict. |
| `profile-review` | Separate cross-model assessment task | A: explicit review-task association; J: selection, authorization and independence. A recorded verdict alone is not an independent assessment. |
| `profile-review` | Follow truncated final response; consume returned offsets to null; do not JSON-parse plain text | A: typed content/continuations; E: valid offsets and format markers; J: external reader consumption. |
| `mcpHub` | Reuse hub tools instead of asking user to reconnect servers | A: expose existing enabled hub tools; J: task fit. |

### Priority mechanisms and quality signals

1. **Dispatch-derived notice:** extend `coordination/observers.rs::inputs_on` and `bulletin/mod.rs` to create/update a notice keyed by the accepted dispatch and evidenced source/session/resource association. Derive project/lane from registered identity and the existing Git baseline, never prompt parsing. An ambiguous association yields an unattributed notice/coverage field without guessing a session. Existing activity, successor and six-hour inactivity semantics own closure. Manual notices remain for work outside ARC dispatch.
2. **Conflicts in receipts:** project matching active notices/blockers from `bulletin/store.rs` into dispatch receipt metadata with canonical resource IDs, age, conflict kind and a board read action. Recheck at dispatch admission; return the board revision so later changes are explicit. Conflicts remain advisory. Replaying the receipt retains dispatch identity and labels the freshness of refreshed advisory information.
3. **Computed policy recommendation:** extend `dispatch_policy.rs::query` and `decision.rs` with eligible account/model/effort/service-tier candidates, one deterministic recommendation, reason codes, evidence timestamps and unknown fields. Use native capabilities, configured allow/deny/defaults, quota availability and measured history only where comparable. Quota pools are shared allowances, not interchangeable account labels. Do not invent a performance ranking from model names. Prose criteria retain risk, task complexity and judgment; explicit authorized selection wins. Missing data produces no recommendation plus an actionable read, not a guessed account.
4. **Found-by outcomes:** `dispatch_policy.rs::{review_record,save_review,summarize_history}` currently retains a free-text `note`, verdict and reviewer provenance; no structured `found-by` field exists. Adopt a documented `found-by` field in review-note metadata (`reviewer`, `user`, `automation`, `unknown`) through the operation schema, with exact legacy note markers imported once and all other notes unknown. Aggregate findings by that field and distinguish the reporter from the dispatching source. Keep self-review, independent review and later user findings separate, with counts/coverage rather than a single quality score.
5. **Later-fix correlation:** reuse `changes.rs::{capture,record,review_evidence}` baselines/terminal snapshots and `coordination/git_watch.rs::{baseline,terminal,Watcher::scan_in,correlate}`. On a changed watched ref, inspect newly reachable commits classified as fixes by an explicit link or Conventional Commit type; intersect changed paths with the turn's observed changed files. Incrementally retain bounded commit/turn references, overlap count and coverage, not transcript content. Label overlap as correlation, never proof of regression or authorship. Dirty baselines, shared files, renames, rewrites and missing history produce ambiguity/coverage fields; no full-history scan on every poll.
6. **Denominators:** report unreviewed dispatches as their own bucket and show still-running separately from terminal-unreviewed. Existing `summarize_history` already has `unreviewed`, but subtracts failed/interrupted before that count; add a review-coverage dimension independent of execution outcome. Keep external reviews and self-tests separate. A control source's pass/rework verdict does not establish predictive validity for later user defects; only linked subsequent outcomes can evaluate that relationship.

Automatic occurrence recording already exists in `coordination/observers.rs::stalled_input`, `claude_notify` delivery failure reporting and `coordination/ax/store.rs::candidate`. AX-07 illustrates that mechanism's repeated use. Store usage alone does not establish “most use” without an aggregate by actor/occurrence origin; add that aggregate to the AX digest rather than equating imported entries, manual reports and automatic observations.

| Increment | Observable acceptance |
| --- | --- |
| D4a: semantic digests | Oversized fixture lists return valid JSON under the budget, actionable IDs/counts and a working path to every full row; no raw prefix is required to decide the next read. |
| D4b: derived coordination | An accepted dispatch creates one notice; retry creates no duplicate; overlapping resources appear in its receipt without blocking it; missing association is explicit; successor/end updates obey D1. |
| D4c: recommendation | The same facts/criteria revision produce the same candidate order/reasons; unavailable quota/capability is labeled; an authorized override remains effective. |
| D4d: outcome signals | A reviewer finding, later user finding, unreviewed completion and fix-path overlap produce distinct buckets; unrelated fix files do not correlate; history gaps stay unknown; no report equates pass with defect-free. |

## Cross-direction delivery order and acceptance boundaries

Sequence lane-sized increments as `D2a -> D1a -> D1b -> D2b -> D2c`, then D1c/D1d and D2d by owner. D4a can proceed independently once each list owner supplies a bounded projection. D4b depends on D1 successor/terminal authority and D2 index invalidation; D4c consumes current policy/account facts, including the `poll-cost` result; D4d consumes stable D1 outcomes and existing Git baselines. D3a can be designed independently; D3b–D3d depend on D1 loss semantics and durable D2 recovery. This keeps ingress transport changes separate from terminal-state and storage changes.

Assign one actual lane per listed increment through repository tooling only after user review. Split D1c/D2d further by owner if needed. One designated owner edits catalog/guide schemas in each batch. Land through the control source. Replace obsolete implementations at adoption, with no permanent dual path. Each increment compiles before landing; observable Contract/Regression/Property cases follow the test policy and `npm test` remains the daily suite. Control-source-owned contract files require an exact dispatch grant. Process replacement and scale/CPU checks are targeted runtime acceptance outside the daily suite, not release-wide matrices.

Completion means selected-turn reads and pushes agree, repeated idle work does not grow with history, Core replacement preserves ingress/execution within the documented request boundary, and a control source can decide from bounded digests with explicit quality coverage. These are independent acceptance axes; no one passing counter or unit test substitutes for the others.

## Open decisions for the user

1. Approve the evidence model, including unconfirmed after owner loss, native confirmation for interrupt, and explicit conflict handling for contradictory terminal records?
2. Adopt files plus a derived activity index first, with unchanged retention, and defer SQLite until measurements justify moving canonical lifecycle storage?
3. Adopt the initial front-door contract of bounded drain and explicit uncertain write/readback, plus a reconnecting front-door update, or require in-flight MCP preservation/socket handoff in the first release?
4. Keep automatic continuation after genuine interruption separate from executor continuity, with no new turn submitted by default?
5. Approve digest budgets/default overflow projection, advisory dispatch-derived notices/conflicts and computed recommendations with explicit overrides?
6. Adopt structured found-by metadata and a bounded later-fix correlation window; which window should the quality digest use before it labels an outcome mature?
