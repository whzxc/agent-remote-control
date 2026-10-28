# Coordination journal

MUST means a requirement. SHOULD means the default unless a concrete task-specific
reason justifies an exception. MAY means an option.

The `coordination` module owns the instance-local metadata journal and `events`
query. `guide`, `query`, `act`, and `notification` retain their frozen envelopes.
AX source writes use the owner store below. Resource push remains a later phase.
ARC observers project dispatch, terminal, receipt, replacement, restart, local
tooling lifecycle and registered Git facts. Source event-report writes and resource
push are not implemented. AX and the bulletin own their separate records and producers.

## Producer interface

Call `crate::coordination::emit(EventInput)` from an internal owner. Construct
`EventInput::new(transition_id, EventKind, resources)` and set only typed metadata.
The return is `{eventId, sequence, duplicate}` after a synced append. The input
has no free-form summary, title, prompt, output or error fields. Summaries come
from fixed templates. `Principal::from_origin` accepts server-captured origin;
null stays unknown and explicit local origin maps to built-in local authority.
Use `Principal::Arc` for evidenced internal ARC activity. Do not infer a source
from an account, label or current task. Account IDs are attribution only.

The owner MUST durably persist its transition and pending descriptor first.
The owner MUST release its lock before calling emit.
The owner MUST checkpoint successful projection afterwards.
The owner MUST retain the same transition ID and payload for retries.
The owner MUST keep older producer checkpoints beyond journal retention.

Replay deduplicates retained transitions, including across restart. A different
payload under the same transition ID fails with `COORDINATION_TRANSITION_CONFLICT`.
Dedupe memory is bounded by retained history; producer checkpoints prevent replay
of transitions already evicted from the feed. A failed observation never changes
a successful dispatch or Git result. Retain it for bounded reconciliation.

`Resources` projects registered project IDs and associated lanes without storing
a second registry. Add registered projects before lanes. `ResourceKey::lane`
returns the qualified key, so later duplicate names cannot change historical
identity. Resolve shorthand through `Resources::resolve` against a current
registered projection; query shorthand resolves against retained event resources.
No key contains a path, account name or actual hostname. `host:<id>` receives an
opaque instance-local ID supplied by its owning observer, never device_name().

## Persistence and locks

One Core owns `root()/coordination/events` under the existing state-directory
lock. Acquire/release the source authorization snapshot first, then the journal
mutex. No owner, notification, network, Git or discovery lock/work runs inside the
journal mutex. Account stores are never read per event. Reads use an in-memory
sequence index; a poll ranges from its cursor. Only startup enumerates files and
rebuilds the bounded index. Retention deletes known segment paths directly.

The manifest stores epoch, cursor signing material, next allocated sequence,
retention floor, ordered segment IDs and bounded coverage counters. Reserve a
sequence durably before append; append and sync the record before success. Never
reuse a reserved sequence after a crash. Atomic metadata writes use a fixed
private temporary file and sync before rename. Unix also syncs the parent
directory; Windows uses the existing private-directory ACL and rename boundary.
A restore/reset requires a new journal epoch; missing/corrupt metadata beside
existing segments requires explicit local recovery, never automatic reset.

Segments are append-only until retention unlinks them. Retention persists the
floor/list before deletion, so restart finishes an interrupted deletion. A partial
final record is copied to one bounded private quarantine before truncation. Failed
quarantine leaves the original readable bytes untouched and fails the read. A
failed append invalidates the in-memory store before any further operation. The
next access recovers the tail. Reserved holes and rate drops are partial coverage.
Malformed interior records fail closed for local recovery.

Limits are seven days, 20,000 events, 16 MiB total, 256 KiB/segment and 2 KiB per
stored record and public projection. Four segment budgets within 16 MiB reserve
space for metadata, its atomic temporary, quarantine and quarantine temporary. Retention
removes complete oldest segments, which can evict adjacent newer rows early.
The memory index, transition map, resource counts and pull buckets are bounded.
No background queue is introduced. Producer overflow returns an error and a
persisted dropped counter; owners remain responsible for pending reconciliation.

Cursor scope binds source authority revision and canonical filters, not account
membership or labels. A high-water mark stabilizes each pagination cycle; the
next completed cursor polls newer observations. Cursor expiry returns a failed
result with an explicit gap and reset query. Retention does not reset sequences.
Public query errors carry actionable `next`; normal transport adds `arcVersion`.

## AX owner store

Maintainer mode defaults OFF. Settings > Experimental and `cli config set --stdin`
with `{"maintainerMode":true}` update the same device-owned ARC preference. The
Core stores `maintainer-mode` as `on`/`off` in its existing preference store. Guide
reads use its current value and include it in `guideHash`; no restart is needed.
OFF guides omit AX workflow and common-index AX ops. They suggest a user-reviewed
GitHub issue and the optional local `ax_issue_draft`. ON guides include reporting,
candidate review, triage cadence and release gating. Coordination guidance remains
available in both modes. The full index and explicit op schemas still expose AX.

`coordination::ax` owns report/list/candidate/triage and explicit local import/export.
AX data belongs only to this instance; it is never sent to the project maintainer.
Triage requires Maintainer mode or authenticated local authority, in addition to
existing entry ownership checks. Import is reachable only through local authority.
Mode changes never migrate or delete AX data. `ax_issue_draft` bypasses the owner
store and journal, reads no receipts or threads, and performs no network requests.
It maps the supplied friction to a fixed category and hashes reference IDs. This
intentionally loses verbatim reproduction detail to exclude prompts, paths, account
emails, credentials and routes; the user reviews and completes the draft manually.
CLI migration forwards to Core; the state-directory lock remains the single writer.
Read source authorization and compact reference evidence before AX locking. Acquire
shared request-ID locks before AX mutation, never owner/discovery/journal locks
inside AX. Reserve the root receipt namespace, persist the request ID and pending
event with the owner record, release AX, emit by stable revision, then complete the
receipt. Reads/retries reconcile up to 64 pending projections; `projectionPending`
distinguishes durable AX records from completed feed projection.

The private snapshot in `coordination/ax` caps at 8 MiB plus an 8 MiB atomic
temporary budget, 1,000 entries and 16 KiB per entry. Occurrence/replay keys,
rate buckets, history and pending descriptors share those bounds. Capacity rejects
preserve readable state. Closed/merged rows expire after 180 days only after an
explicit export of their current revision and completed projection. External
archives are never automatically pruned. Open entries remain retained.

Owners call `ax::observe(Friction, observation_id, principal, evidence_refs)` after
releasing their locks, retaining stable observation IDs. Receipt-stalled and
delivery-failed journal events feed it at emit; owner-discovery timeout results
feed it at control dispatch. AX events cannot recursively generate candidates. Receipt observers only persist
and emit their stalled transition; they do not call AX directly. Journal retries
retain the transition ID consumed by AX occurrence deduplication.
Candidates coalesce for ten minutes; rejection suppresses the same signature/build
for 24 hours. Only the associated source or local authority confirms them. Pull
results expose confirmation and triage requirements without adding push or release
authority. Reproduction and reference details stay owner/local-only.

The local importer reads only the supplied file and recognizes three queue
sections: AX frictions, Backlog ideas and Follow-ups. There is no bundled backlog
or seed import. Maintainers keep their queue files outside the repository. A small
synthetic fixture covers policy/history exclusion, reported fixes and idempotency.
Retire a queue only after import readback.


## Observers and owner boundaries

`observers::save_owner` adds typed `coordinationPending` descriptors to the owner
record and syncs one atomic replacement for an unprojected transition. Ordinary
text/progress writes with no pending projection retain their existing save behavior.
Dispatch history owns submitted dispatches; Agent dispatch becomes observable after
the prompt frame is flushed, not while its configuration is merely prepared.
Agent task records and native terminal frames own observed terminal transitions.
Native frames are recorded even without a notification binding. Replacement workers
persist descriptors only; they never open the journal from a second process.
The Core projector emits outside owner locks, then syncs a separate checkpoint.
The first durable terminal observation is canonical across native, Desktop and
reconciliation paths. Retry keeps its descriptor and transition ID.

Receipt reservations enroll a known path for bounded phase-age observation. A phase
stalls after the same 30-second threshold as `progressStalled`; this does not prove
execution failure. After recording one stall, the observer stops polling that phase
until another owner checkpoint. Historical receipts with missing or empty source IDs
retain unknown origin; ingress names and labels never supply a source identity.
Malformed receipt metadata is skipped per record and leaves the age-poll set until
an owner write. `coverage.observers.receipts.skippedInvalidRecords` counts distinct
sampled invalid paths, removes repaired records, and caps at 4,096 per Core lifetime.
`invalidCountCapped` indicates that more invalid paths were encountered. These
records do not invalidate other receipt observations or change receipt execution.
Unconfirmed backend-session reads persist a separate
observation without rewriting a live receipt. Replacement interruption counts require
the finalized shutdown snapshot and exclude `finished-before-shutdown` entries.
Unknown counts stay absent. `resumeSubmissions` counts completed resume-operation
receipts with a turn ID, never completed successor turns. Recovery summary is separate
from replacement success. Replacement events project the recorded `submitter.origin`
when present, including recovery summaries. A plain terminal without recorded
submission context remains unattributed. Existing journal events and producer
checkpoints are not rewritten. Restart evidence identifies the new Core instance.

Startup discovery and the pending path set cap at 4,096 records. Owner records retain
at most 128 descriptors. Native snapshot ingestion caps at 128 terminal turns per
snapshot. The derived observation/checkpoint/tooling/ref stores cap at 8,192 files
and 16 MiB in aggregate, separate from the journal's budget. Individual metadata
files cap at 128 KiB. Capacity preserves existing records and reports a coverage gap;
it does not evict producer checkpoints with feed retention. These checkpoints may
only be removed as part of explicit local archive/recovery that also reconciles their
owners. No background directory crawl or unbounded pending queue is introduced. Coverage
projection itself caps at 16 KiB and is reserved in the 128 KiB event page budget.

## Registered Git observation

The watcher consumes the registered project projection from successful existing
`project/list` reads. It never starts app-server or performs an upstream poll merely
to discover projects. `coverage.observers.projectRegistry.observedAt` is the last
upstream read, not proof that registration remained unchanged while disconnected.
An unavailable projection is a gap until an ordinary project query refreshes it.
The watcher may start before that first read. A later successful snapshot read
sets `git.state` to `observed` and retains the earlier failure in `git.lastGap`;
individual registered-root gaps remain visible separately. An initial ref snapshot
establishes the baseline and does not fabricate historical ref-movement events.
Private roots remain in local state; shared events expose only registered IDs.

The initial bounds are 32 roots across at most 32 projects, 8 roots/project and
128 watched refs/root. Only `refs/heads/main` and `refs/heads/wt/<lane>` are watched.
The shared Git directory includes known worktree lanes without registering a second
project. Loose and packed refs are read with file stamps; unchanged polls open no
ref files or directories. Reads cap at 256 KiB, directory enumeration at 129 entries.
Nested lane names, excess refs, inaccessible roots and repository replacement report
gaps. Attached, unborn, detached and unwatched HEAD states remain distinguishable.

Polls run every five seconds while an in-process turn baseline is active, otherwise
every thirty seconds. A project deadline is two seconds. A timed-out filesystem read
remains the single in-flight worker; later polls skip it instead of accumulating
workers. An unchanged ref launches no subprocess. Changed refs use the existing
safe Git runner for ancestry, serially, without hooks, fetch or writes. An ancestry
error is `movement:unknown`, not a non-fast-forward claim. Observations coalesce
intermediate unseen changes.

Correlation requires the same canonical common directory, branch, old HEAD and an
overlapping observed turn interval. One candidate is `correlated`; multiple turns,
even in the same thread, are `ambiguous`. Missing evidence, failed observation or
restart discontinuity is `unknown` (unattributed). Author identity is never evidence.
The observer never mutates Git, registers projects or resumes threads.

## Local tooling reports

`coordination.observe` and `coordination.observation` are authenticated local
management operations, absent from the control-source op catalog. Worktree tooling
persists a stable transition before its action and marks completion before reporting.
Core validates the registered parent, current worktree/ref state and land ancestry.
Isolated supervision reports an opaque instance, actual child start/exit and exit code;
Core reads process liveness. Starting is not readiness. A lost supervisor supplies no
fabricated exit. A successful POST requires a separate transition readback.

Tooling uses a 64-record local outbox and reconciles at most two previously completed
reports per invocation, keeping their IDs and payloads. It never retries the original
Git or process action. Confirmed tooling records may be pruned locally because Core
retains their producer checkpoints. Failed/partial operations, unavailable Core,
unregistered roots and failed readback print `coverage:missing` without changing the
original command exit result. Prepared-but-unconfirmed actions are not replayed.

`events.coverage.observers` exposes sampled coverage, last gaps, HEAD state and
registry age. Journal coverage and observer coverage are separate: a healthy journal
cannot imply that an offline tool, inaccessible repository or missing baseline was
observed. Observers add no resource subscription or message. Bulletin claims are advisory and never execution leases.

## Bulletin and resource blockers

`coordination::bulletin` owns `coordination/state.json`. The source-facing ops are
`board`, `coordination_session`, `notice_post`, `notice_update`, `notice_close`,
`blocker_open` and `blocker_clear`. These are catalog operations behind the existing
frozen tools, not new MCP tools or guide topics. Existing explicit op allowlists
still require local adoption. Recovery broadcast uses the private messaging outbox
and its existing delivery adapter.

All authorized sources share the metadata board. Source/account labels, task
prompts, transcript excerpts, private routes and arbitrary owner records are never
projected. Intent and blocker summary are single-line, source-reported metadata,
limited to 240 characters. Source authority comes from authenticated origin;
account membership does not grant mutation authority. A source can mutate its own
records; built-in local authority can administer them. Optional logical sessions
are ARC-issued, source-owned handles, pull-only until an explicitly verified
`message_route` is bound. They provide no stronger isolation than the source credential.

Read `board` before shared-resource work. Its default summary
contains one line per active notice or uncleared blocker, plus compact IDs,
revisions, owners and activity metadata. Use `view:full` for resources, editable
fields, thread links and clearance evidence. `id` reads a retained terminal record;
`state:all` includes history. Resource filters select metadata, not visibility.
Pages default to 50, cap at 100 and fit 128 KiB. Cursors bind snapshot lifecycle
revision, filters and source authority, expiring after 15 minutes or a scope
change. Activity refresh alone does not invalidate pagination.

Every notice includes `lastActiveAt`, `inactivityAgeSeconds`, `observedAt` and
`activityCoverage`. Expected duration is an estimate, never expiry. Authenticated
owner operations, including guide reads, refresh activity automatically. Another
source's pull, delivery retries and repeated terminal observations do not refresh
it. Existing live Codex/Agent timeline caches supply running-thread observations;
no new upstream request, process discovery or directory scan is introduced.
Disconnected or unavailable observation becomes a gap. A missing observation never
proves completion or supplies a fresh heartbeat.

All linked scopes reaching a confirmed completed/failed terminal state closes the
notice with `closedReason:threads-ended`. Interrupted/cancelled scopes remain open
for continuation. A source-matched durable `turn.successor` descriptor advances a
link from predecessor to successor; an arbitrary newer turn cannot inherit it.
Resume receipts and observed native retry records own these descriptors. Delayed
predecessor terminal frames cannot end a successor. Bounded per-link terminal
metadata handles successor/terminal projection arriving out of order. Only the
latest 16 terminal facts per link are retained; missing older observations remain
a coverage gap until current live observation or explicit owner correction.

Six hours without evidenced activity withdraws an otherwise active notice with
`closedReason:owner-inactive`. Explicit closure and source revocation end its
claims. Source blockers become stale after six hours; revocation makes them
uncertain. Neither state means cleared. Clearance requires evidence IDs and either
a locally verified `{projectId,oid}` commit or an explicit non-code recovery reason.
Commit existence does not prove deployment or remediation. Clearance records
`suggestedNextStep:inspect|consider-resume|ask-user` and never resumes a task.

Runtime age uses monotonic elapsed time anchored to UTC. A wall-clock discrepancy
of at least 60 seconds makes age unknown and suspends automatic expiry. Restart
preserves persisted timestamps and marks previously running links unknown; it
never renews them. UTC is the restart age basis, so undetectable wall-clock changes
while Core was stopped cannot be reconstructed. Activity is coalesced in memory
and persisted at most once per minute, or with a durable mutation/observation;
a crash can lose up to that interval of freshness. Restart coverage discloses the
gap. Failed persistence leaves the last readable snapshot intact.

The snapshot and one atomic temporary share 4 MiB. Limits are 256 notices,
128 blockers, 128 sessions, 512 pending event parts and 2,048 mutation replay
records. Each notice has at most 16 resources and 16 thread links. Per source,
limits are 16 active notices, eight uncleared blockers, eight active sessions and
four session registrations/hour. Writes share 30 mutations/minute/source;
request-ID replay does not consume the budget twice. Terminal rows and mutation
replay records retain seven days. Pending transitions prevent owner-row pruning.
Capacity errors preserve existing state and require local cleanup/recovery. Incomplete
receipts older than the replay retention cannot reapply an evicted mutation; inspect
the original receipt and board before explicitly starting a new work scope.

Acquire and release the source authorization snapshot before the bulletin lock.
Acquire request-ID locks before mutation. Thread-origin and fixing-commit evidence
reads run outside the bulletin lock. Mutations atomically persist the owner record,
request digest/result and pending descriptors, release the lock, call
`crate::coordination::emit`, then checkpoint projection. Event parts contain at
most four resources to fit the existing 2 KiB journal budget. `notice.changed` and
`blocker.changed` expose typed state and opaque owner-record references, not intent
or blocker free text. Pending projection is retried in bounded batches on reads
and in the existing observer loop. Terminal/successor evidence is saved before the
upstream observer checkpoint. No new polling task is added.

## Advisory action warnings

Posting/updating notices and local shared actions return
`conflicts:[{noticeId,resource,state,lastActiveAt,inactivityAgeSeconds}]`.
Conflicts include same-source sessions and never reserve or block resources.
Responses cap warnings at 100; `conflictCoverage:partial` requires a board pull
for the complete paginated resource picture.
`conflictCoverage:unknown` means the board/resource mapping could not be read;
it is not evidence of an empty board. Sources should weigh inactivity age.

The authenticated local `coordination/conflicts` route reads the cached registered
project projection. Worktree land and isolated startup print advisory preflight
warnings, then execute independently and return current warnings with lifecycle
readback. Missing Core leaves the original command result unchanged. Main-only
worktree/isolated guards remain authoritative. Replacement submission persists
`app:installed` warnings in its normal receipt. Explicit simple `git push`
submissions through `command`, including its native argv form and `git -C`, return
warnings when their directory maps to one registered project. Shell scripts,
aliases, arbitrary external pushes and unregistered directories are not inferred;
ref movement alone never proves a push. Pull `board` before those actions.
observed. Observers add no resource subscription, source claim, lease or message.

## Addressed messages

`message_send` accepts `request|grant|deny|conditional|notice`, a `toSourceId`,
optional logical `sessionId`/`toSessionId`, 1–16 canonical resources and a single-line
summary of at most 240 characters. `relatedIds` holds at most 16 opaque references.
Conditions allow only `notice-closed`, `blocker-cleared` and `ref-equals`; conditions
are data and never execute policy. Envelopes are capped at 4 KiB. Never include
prompts, transcripts, credentials, paths or private routing data.

`messages` reads the authenticated source's inbox or outbox (`direction`), with
optional session/negotiation filters, a cursor and a limit of 1–100. Cursors are
bound to the source authorization, epoch and filters, survive restart, and report
`MESSAGES_CURSOR_EXPIRED` after retention or authority changes. Read messages
before shared-resource work and reply only when necessary. Source-only messages appear in the
unfiltered inbox. A session filter selects only messages addressed to that session.
The sender can inspect its own sent mail; unrelated sources see no private bodies.
The shared journal emits only fixed lifecycle facts, without message summaries.

Replies require both `negotiationId` and `inReplyTo`. A request starts a negotiation;
a grant/deny answers a request or conditional. All source replies, including notices,
consume one combined budget. The initial request consumes no reply slot. The owner
snapshot atomically reserves each slot with the message. Retrying the same
`requestId` and arguments cannot consume another slot. Receipts retain only IDs and
a query pointer; private mail remains in its owner store.

Reply three marks the exchange escalated, adds a notice to both participant inboxes
and retains one local attention item in the negotiation. Further replies fail with
`NEGOTIATION_LIMIT` and a human-mediation `next`. This also blocks new negotiation IDs
for the same source pair and any overlapping resources. Session/account changes
cannot reset the counter. Escalation holds outlive mail retention until a local user
decision. At most four negotiations per source may be open and ten may be initiated
per hour; the source bound also covers all its sessions. Exchanges expire after
24 hours, except unresolved escalation holds.

Local management `GET coordination/messages` exposes messages and attention items.
`POST coordination/messages` accepts `negotiationId`, `expectedLastMessageId`,
`action:resolve|reopen` and a reason of 1–240 characters. It records the local actor
and decision; reopen supplies a fresh three-reply budget. Control-source catalog ops
cannot perform this mediation. Grants and user mediation never execute a task or
change host permissions.

### Delivery boundaries

A source-only send may capture exactly one registered, verified Claude destination.
Multiple destinations remain pull-only. Logical sessions use `message_route` to
associate their own active session ID with an already verified source-owned Claude
target; `target:null` removes that association. Session registration alone never
selects a private conversation. `message_route` does not register or verify targets.
Use `notify_control` and `notification_ack` for the existing handshake first.

The private outbox captures an opaque route reference and generation. Raw cloud
addresses and profile routing remain exclusively in notification storage. Explicit session
closure/unbinding, source revocation, credential changes and notification route
changes cancel pending sends. A route is checked again before transport. A send
already handed to the upstream CLI cannot be recalled. Unsupported sources,
including ordinary Chat and Work private conversations without direct addressing,
remain pull-only. Work resource callbacks are not a private conversation API.

Only SRC peer messages from `message_send` enter the proactive outbox. ARC-generated recovery and negotiation-escalation notices remain pull-only.

The first peer message waits 30 seconds. All pending peer mail for that target coalesces into
one count and `messages` pointer, with at most one attempt per target per 60 seconds.
Push starts with `⟢ ARC receipt — automated` and labels the envelope automated data,
not user instructions. Peer summaries and conditions are excluded from push bodies.
The same target bucket, breakers, master switch and mute controls govern admission.
Coordination reserves two remaining bucket tokens for task notifications and observes
a lower-priority three-per-minute ceiling. No network call runs under the message
store lock. An uncertain transport outcome or restart after send reservation becomes
`unconfirmed`, with no automatic resend; clients recover by pulling mail. Transport
acceptance is `delivered`, never proof of model processing or task execution.

`coordination/messages/state.json` owns bounded messages, negotiation counters,
private route references, coalescing timestamps and pending event descriptors. Its
4 MiB snapshot plus atomic temporary fits the 8 MiB budget. Mail retains at most
2,000 rows for seven days; pending delivery expires within 24 hours. Negotiations,
route associations and target cooldowns are each bounded at 128. Local mediation
history retains at most 64 decisions per exchange. Capacity failures preserve the
previous snapshot and return an actionable error. Source/notification snapshots are
read before acquiring the message lock; journal projection and network delivery
follow release. Recovery broadcasts use this outbox; message acknowledgements remain
a separate capability.

### Recovery broadcast

Clearing an owned blocker creates a durable advisory selection and one `recovery`
message per affected logical session. Rely on this broadcast instead of messaging
sessions manually. Repeating the clear or replaying after restart retains the same
logical message. A blocker that became stale can be explicitly cleared, but its
clearance never broadcasts. No recovery message, acknowledgement or delivery
resumes a task or changes its continuation configuration.

Selection uses retained journal events only. An interrupted, cancelled or failed
turn must occur in the recorded blocker window and overlap its resource keys.
Its original dispatch source must differ from the clearing source. Local authority
may select any evidenced source-owned turn. An earlier notice event must link the
exact turn to one unambiguous logical session of that same source. Register the
session, bind its verified route with `message_route`, then post a notice linking
the dispatched turn before interruption. A current account, title or recently used
conversation cannot supply historical ownership. Older events without this binding
remain unresolved; the implementation does not reconstruct historical sessions.

The selector scans retained candidates in pages of 100, caps at 1,000 turns, and
reports truncation and retention gaps. It excludes completed successor chains,
unrelated later dispatches and recorded replacement continuations. Current source
revocation and session closure prevent mail creation or push. Unknown task state
produces `inspect` advice: recipients inspect current state and decide whether to
resume or ask the user. Native occurrence time is preserved when available;
otherwise the reference explicitly reports observation-time evidence. Co-occurrence
is candidate impact, never proof that the blocker caused a failure. Archival or
upstream state absent from events remains unknown; selection does not probe an
Agent or infer that a task may safely resume.

Messages include cause, bounded summary, clearance attribution, evidence IDs,
verified fixing commit or its explicit absence/reason, reported next step, and
recipient-owned thread references. Source clearances are labeled `claim` and
`source-reported`; a valid Git commit proves neither deployment nor recovery.
The private message exposes up to 20 references with a `messages` continuation
cursor for the remainder. Other sources cannot retrieve those pages. The shared
board reports selection counts and coverage only. Local-authority `board({id})`
also returns `localRecoverySelection`, including unresolved evidence for mediation.

Recovery mail remains pull-only in the existing message store, including when the original session has a verified route. Successor completion is checked again on message reads; obsolete advice is suppressed. Message creation and suppression emit existing coordination message events. Pending owner projections keep clearance selection retryable after a crash. Replacement outcomes remain inbox-only and do not reserve a shared wake with recovery mail. Existing replacement continuation requests remain the sole replacement-specific actions. This does not introduce another resume or change the model, prompt or request ID.

Proactive conversation wakeups are limited to four classes: task completion; task failure, including an interruption that ARC did not automatically resume; pending execution questions and approval requests; and SRC peer messages delivered by message_send. The push-binding verification code remains a separate channel handshake. Automatically resumed interruptions MUST NOT wake the conversation. Update and restart lifecycle notices, merged post-recovery resume notices, ordinary restart recovery, ownership handoffs, progress, stalls and all other lifecycle kinds MUST remain inbox/event-center only. A question or approval blocking update settling wakes once through the ordinary interaction path, with no separate update notice. Query update_status, board, messages or the owning task for recorded lifecycle state. Existing verification, source scope, subscription filters, buckets, breakers and mute rules apply. Delivery does not prove client reconnection.
