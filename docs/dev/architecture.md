# Architecture and lifecycle

[Remote link](remote-link.md) · [Development](development.md) · [Tools](../reference/tools.md) · [Agents](../reference/agents.md)

## Processes and responsibilities

Existing HTTPS ingress listeners also serve the read-only browser dashboard. The front door embeds its static assets after the frontend build. The public browser surface uses a separate 256-bit key generated through local `browser.access`; `browser.access.rotate` replaces it. The initial key URL establishes a persistent Secure, HttpOnly, SameSite=Strict cookie derived from the current key. The browser saves the key in path-scoped LocalStorage and removes the query parameter before rendering. Later document and resource requests use the cookie; API requests also accept the stored key as a Bearer credential. Authentication precedes browser route lookup, so unauthenticated pages, assets, and data return empty HTTP 401 responses. Browser routes allow only explicit reads and validate their management schemas. Mixed-purpose task control, request routing, and resource operations accept only queue reads, routing reads, and image reads respectively. The browser shares the desktop topology, panels, account cards, conversation list, and task timeline; write controls are disabled. The local management API remains private. Existing MCP/OAuth routes retain their own authentication and authority. Browser presence and preference writes are disabled. The browser forwards the existing status, activity, and quota streams and closes them when the key changes. OpenAI Secure Tunnel remains MCP-only. See [Remote browser](../guides/remote-browser.md).

```text
React / Tauri Desktop ─┐
CLI / management MCP ──┼─ authenticated local HTTP ─ Front door ─ private IPC ─ Core
HTTPS / OAuth / relay ─┘                             ├─ listeners              ├─ Control
                                                    ├─ ingress auth/config    ├─ AgentHost
                                                    └─ providers / relay      └─ business state
Detached Codex app-servers and task-hosts ────────────────────────────────────────┘
```

React renders in the system WebView. Desktop owns the main window, tray, native panels, permissions, and updates. arc-core provides shared business and runtime capabilities. runtime maintains one file-locked Core per state directory. Local entry points such as Desktop and CLI hold leases. A live Desktop lease keeps Core resident even if its heartbeat is delayed. Different builds cannot share an active owner. Core exits when the final owner releases its lease or is gone. Daemon mode can remain resident independently.

Updater scheduling starts after Core is attached. Desktop reads effective network settings through Core's network operation, including first-launch defaults. Desktop owns one serialized updater pipeline for scheduled checks, manual checks, downloads, and installation. A successful check downloads its offered update while keeping the same operation lock. Overlapping checks join the current result; queued downloads reuse verified bytes. Frontend code never starts an automatic download. Update events and polling carry complete snapshots with increasing revision numbers. The UI rejects older snapshots. Starting a check clears the old offer and progress; check failures expose no stale version. Download failures retain only the current retryable offer and identify the failed stage. Restart discards historical offers and in-memory download readiness. Production-identity packages support updates in both release and debug profiles; the separate development identity cannot install production updates.

service::Service owns one Control, AgentHost and execution::Execution. Its ingress handles are derived dispatch projections. front_door::owner::Gateway owns the live ingress collection and configuration. Execution composes business capabilities. kernel stores provider-independent origin, tool policy, receipts, results, and events. Transports package requests and results. egress projects errors and output consistently.

### Front-door process and private Core protocol

`arc front-door` owns the local HTTP endpoint, HTTPS listeners, TLS-facing routing,
OpenAI Tunnel providers, managed HTTPS providers, relay links, OAuth grants and
pairing, browser authentication, HTTP/MCP transport state and bounded buffers.
It constructs no Control, AgentHost, account manager, scheduler or receipt store.
`arc serve` and `arc daemon` keep `core.lock`, dispatch, receipts, source authority,
accounts, coordination, scheduling and detached executor adoption. Core shutdown
closes its private IPC connections and business observers. It leaves the front door,
listener addresses and provider processes running. Restoring connection intent is
idempotent for surviving ingress runtimes; explicit ingress restart replaces them.

Core first binds its private IPC endpoint, then attaches to the front door. If none
is running, it copies the installed standalone executable to
`<state>/front-door-bin/v<protocol>/<build-id>/arc` (`arc.exe` on Windows) and launches its
`front-door` mode with the existing detached-spawn helper. Unix uses `setsid`.
Windows uses the existing process-group and job-breakaway launch policy. The copied
image permits Windows installer file replacement while the front door is running.
Every fresh launch selects the installed executable's content build ID, even when
the protocol is unchanged. After recovering old children, the new front-door lock
owner removes superseded image copies while retaining its current build.
`front-door.lock` admits one owner per state directory. `app/front-door.json`
publishes its PID, process creation identity, protocol, running build ID and stable
local endpoint. Existing ingress, service, health and headless runtime status include
`frontDoor.build`, `installedBuild` and `matchesInstalledBuild`. A retained compatible
front door can therefore report a different build from the current local entry point.
`app/native.json` keeps the current Core identity and that same endpoint for existing
Desktop and CLI clients. Local Core discovery and management requests first use
that same authenticated private Core socket or pipe. This includes `cli app quit`
and lease/shutdown requests while the front door is absent. Older installed peers
may use the existing authenticated local HTTP path when private attachment fails.
Once a request is submitted over IPC, it is never retried over HTTP.
No business request automatically launches or replaces Core.
Desktop leases and the existing headless entry points retain that responsibility.

macOS and Linux use mode-0600 Unix sockets in a mode-0700 directory under
`/tmp/arc-ipc-<uid>-<state-hash>/`. The hash uses the canonical state path and avoids
the Unix socket path-length limit. Each Unix listener checks its socket path every
five seconds. If a temporary-file cleaner removes the path or its directory, the
owner rebinds it without restarting Core, providers or accepted connections.
Windows uses per-state named pipes and rejects
remote clients. Both peers authenticate with the private per-state token before
context decoding. `Hello` negotiates protocol version, generation, readiness and
encoded frame bounds. `Request` carries its generation, request ID, deadline,
server-derived authenticated context, operation and body. Responses correlate the
request ID and generation. Stream frames add an ordered sequence number. Core
revalidates current source authority at admission and delivery. A completed response
is checked against the latest attached Core generation before public delivery.

`front_door::InProcess` is Core's bounded request executor behind the IPC server.
It admits at most 128 business calls. Snapshot streams have a separate 128-slot
budget and do not delay business drain; the private listener caps total concurrent
connections at 128. Encoded requests are capped at 36 MiB and responses at 64 MiB.
Existing smaller HTTP limits still apply. Ordinary calls and streams retain an
absolute 1830-second deadline; browser reads use 30 seconds. Each stream channel
holds one frame and waits at most two seconds for its consumer.

On normal Core replacement, Core closes business admissions, drains admitted calls
for at most five seconds, then stops business observers and private connections.
Drain acknowledgement belongs to the original generation. If the deadline expires,
shutdown continues and callers reconcile original receipts. Crash skips drain.
The front door retains the listeners and provider processes throughout either path.

Before transmission, waiting futures own permits in a front-door memory queue:
at most 64 requests and 64 MiB of aggregate encoded request data. Queue admission
assigns or preserves request identity before waiting. Full capacity rejects the new
request with the existing JSON-RPC internal-error code, `FRONT_DOOR_BUSY` message,
request ID and guide next action. An accepted identity is never evicted. The queue
waits for a ready compatible Core, preserving the original absolute deadline.
Expiry returns `FRONT_DOOR_DEADLINE_EXPIRED`, the request ID and a guide next action
identifying that the request was not sent. Cancelling a waiting future releases its
entry and byte permits. Front-door shutdown closes the queue before provider teardown,
so its authority updates cannot wait for an absent Core. There is no persistent
front-door queue or receipt store.

Closing a private request connection cancels only that generation's admitted request
future. Explicit cancellation is generation-fenced and never cancels an Agent turn.
MCP cancellation releases the matching front-door wait future and its private
connection; a cancellation notification is never queued for a new Core generation.

Authentication stays in the existing modules: `oauth`, `browser`, local Host,
loopback-peer, Bearer and Origin checks, and the official OpenAI Tunnel upstream
identity. Headers cannot manufacture an ingress or source identity. The front door
owns grant and ingress mutations. `front_door::authority` forwards source-store
operations to Core, which remains the single revocation owner. It keeps no source
authority cache in the front door. During a swap, authenticated MCP principals wait
in the bounded queue before Core resolves current source authority and admits the
business call. Bearer and OAuth transport authentication validates local credentials;
OAuth also preserves resource and access-token expiry checks. It does not wait on
Core source queries before queue admission or cancellation. Authority failure rejects admission. Revoked sources remain rejected
after Core reconnects. Core keeps
operation authorization, task association and resource boundaries in `core_requests`
and the business owners. The public MCP, notification and CLI envelopes are unchanged.

A read sent to a lost Core fails explicitly. A sent write returns an uncertain
outcome with its original request ID and an `act receipt` read action. When an act
request omits its optional receipt ID, the adapter assigns it before transmission
so the uncertain response and Core receipt use the same ID. There is no write
resend, turn-completion inference, account selection or Agent restart in the front
door. Forwarding begins at the first transmitted byte; a partial send is ambiguous
and has no retry path. The completed-write receipt remains Core-owned and uses the
same progress model as other operation receipts.

Snapshot streams keep their public transport connected after losing Core. They send
an explicit snapshot-gap error with a fresh-snapshot recovery action, wait within
the original deadline, and reattach to ready Core with a new generation and a reset
private sequence. The next snapshot replaces prior state. Authority failures,
correlation errors, deadline expiry and slow consumers end the stream.
Waiting streams send keepalives every 15 seconds and retain one-frame backpressure.

MCP `notification` subscriptions use the existing persistent webhook owner rather
than a Core socket stream. The new Core reads the original subscription identities,
filters, pending deliveries and expiry; the front door retains the ingress transport.
Replacement does not resubscribe, extend TTL, synthesize events or add replay.
Existing delivery retry, retention and expiry semantics remain notification-owned.
A requested cursor replay still returns `-32602` and `replay_not_supported`, with a
`query notify_status` next action to inspect subscription expiry and delivery diagnosis
and reconcile referenced tasks. Expired subscriptions must be renewed without a
cursor. The event name, payload and `{op,args}` subscription envelope are unchanged.
An unavailable front door reports reduced continuity for Core-bound fallback
transports; Core does not open a second listener.

Core and front-door children use disjoint `core-children/` and
`front-door-children/` process indexes. Each lock owner reclaims only its own dead
predecessor's process trees, checking process creation identity before signalling.
The detached front door itself never enters the Core index. Uninstall stops Core,
the front door and its providers, then the detached executor owners.

`arc front-door-prepare` is the install compatibility check. A compatible running
front door is retained regardless of the installed build ID. An incompatible one
is stopped through the authenticated lifecycle endpoint; the next Core attachment
starts the installed protocol image. The local installer runs the candidate's
check after Desktop and Core have exited and before replacing files. Preparation
holds `front-door-install.lock` exclusively and refuses to stop a front door while
Core still owns `core.lock`. The local installer uses `front-door-prepare --hold`
and keeps its stdin pipe open through replacement or rollback. EOF or installer
exit releases the kernel lock. Startup and `ensure()` hold shared locks while
attaching or launching; they cannot launch during replacement.

Desktop/CLI Core startup and `arc start` first discover the existing Core through
private IPC. They reuse a matching owner, reject a different build, and prepare
front-door compatibility only after Core ownership is free. A new Core binds IPC
and ensures the front door before publishing its endpoint. Direct Core attachment
refuses an incompatible protocol with an actionable error. The built-in updater
pauses Desktop's Core client, stops Core, acquires replacement ownership, then
stops the front door before the official installer replaces files. Its downloaded
image may change the protocol. Failure releases replacement ownership and resumes
the installed Core; its next start recreates the front door.

While Core is alive, its attachment supervisor checks the front door once per
second. Lost attachment runs the existing `ensure()` path, which retains the
single-owner front-door lock and honors replacement ownership. Failed attempts
back off for 250 ms, 500 ms, 1 s, 2 s, 4 s, then at most 8 s; success resets the
backoff. Each launched process is logged. Every newly attached front-door
generation republishes the local endpoint and restores persisted remote connection
intent, including providers, independently of Desktop leases. Core shutdown aborts
this supervisor with its IPC listener. Platform supervision and front-door self-update
belong to D3d. Private protocol v2 adds the queued authenticated-ingress context.
Installing v2 replaces a running v1 front door through this compatibility path;
a compatible v2 front door remains retained until it restarts.

The targeted process fixture uses synthetic providers and isolated state. Run it
serially from the main checkout, or an explicitly authorized lane, after
`npm run check:tests`:
`cargo test --locked -p arc-core --features test-fixture --test front_door -- --ignored --test-threads=1`.
It covers listener/provider identity, swap-time queued reads, snapshot reattachment,
persisted MCP subscription identity/expiry, actionable unsupported event replay,
completed-write receipt reconciliation after response loss, compatible install
retention and rejected unauthorized/revoked sources. Fixture-only hooks hold a
selected write response and permit one selected synthetic loopback callback URL.
Production builds include neither hook. Real native-turn survival and public webhook
notification delivery remain separate runtime acceptance steps. Fast private-protocol and HTTP authentication
cases run with `cargo test --locked -p arc-core --lib front_door`.

Core's `resources` module owns process resource policy. It runs at runtime startup and Service initialization, and checks again before each Rpc creates app-server. Desktop, login startup, and Linux daemon share this path. Login items do not maintain separate limits. macOS/Linux attempt to raise the `RLIMIT_NOFILE` soft limit to 8192 while preserving higher soft limits and the original hard limit. macOS also respects `OPEN_MAX` and the read-only `kern.maxfilesperproc`. Global system limits remain unchanged. Each attempt records the original, target, attempted, and measured values and failure reason. Failure or a below-target limit does not stop Core.

Status requests read resources on demand without a monitoring task. Core limits are measured in-process. Rpc records the app-server PID, creation time, and inherited startup limits. A detached server reports `detached` and `adopted`; its PID is checked against the recorded creation time on every read because it may not be Core's child. Linux reads child limits through read-only prlimit and counts `/proc/<pid>/fd`. macOS enumerates descriptors with `proc_pidinfo(PROC_PIDLISTFDS)` and labels limits as inherited startup records. Child exit status is checked before and after sampling. Exit or read failure yields null counts and unknown status without sending child commands. Windows reports not applicable. Communication readiness is separate from resource health. Known descriptor use at 90% of the soft limit produces `APP_SERVER_FD_PRESSURE`. Degraded limits produce `CORE_NOFILE_DEGRADED` or `APP_SERVER_NOFILE_DEGRADED`. These diagnostics neither unsubscribe threads nor restart processes.

Service status, CLI status/doctor, and Settings share resource snapshots and diagnostics. doctor uses `permissions/passive`. Codex login and command permissions remain unknown in passive reads. The explicit permission page retains active probing. Resource diagnostics never start app-server. See [CLI resource diagnostics](../reference/cli.md#resource-diagnostics).

Turn lifecycle consumers classify decoded owner snapshots through `turn_lifecycle`.
Dispatch policy retains a scoped frontier with each outcome projection and uses it
for review admission, history and duration classification. Queue admission consumes
the selected native turn frontier; explicit resume can permit a failed or interrupted
predecessor without changing that predecessor's outcome. Coordination passes typed
frontiers between live owners and bulletin links. Work scopes end on native completion
or failure, while interrupted scopes retain successor eligibility. Owner loss and
unordered terminal conflicts cannot create terminal events or close work scopes.
Resident changed-path collections and runnable queue indexes own discovery and reuse;
lifecycle classification does not reload retained task or receipt payloads.

## Browser transfer policy

Browser status snapshots omit diagnostic logs, request counters, and duplicated platform catalogs. They include the source identities needed by the topology. The browser status stream compares semantic state without observation-only timestamps and sends keepalive comments while unchanged. Receiving a snapshot does not trigger a second status request. Reconnection uses the existing snapshot read.

Task list responses contain metadata and a first-line prompt preview capped at 256 characters. They exclude prompt bodies, attachment payloads, execution settings, and receipt evidence. Owners retain original content; selected conversation reads provide the timeline. Conditional GET and supported read-only POST requests use ETag/If-None-Match at both the local Core and public browser boundary. An unchanged read returns HTTP 304 with no body. The browser retains at most 64 read responses and 32 MiB of response weight in memory. No task response is persisted in the HTTP disk cache.

## Idle resource retention

OAuth grant authorization, notification revocation checks and source preference
reads use the current source authority store directly. Source response projection
reconciles all rows in one account transaction. Notification subscription routing
filters subscriptions before inspecting delivery bodies and does not clone the
complete delivery collection to find existing routes. Full token buckets do not
advance their persisted refill clock while idle; spending the first token starts
the refill interval.

Desktop IPC removes pending requests when their futures are dropped, including
outer timeouts. Request deadlines cover writer-lock acquisition, frame writes and
the response. A failed frame write retires the connection. Pending diagnostics
group current requests by method and expose the oldest request ID and age per
method so repeated samples can distinguish turnover from a stuck request.
Repeated snapshots of the same owner/revision refresh cache age
without repeating event and interaction projection. Snapshot retention expires
after four seconds, with a one-second cleanup cadence, and admits at most 64
entries and 32 MiB of serialized frame weight. A single larger supported frame
may exceed the byte budget until expiry so native history reads remain supported.
Serialized weight is not a heap bound; the IPC frame limit remains independent.
Eviction never deletes native history, changes authorization, or cancels a task.

Notification bindings have a persistent derived activity index initialized in a
background blocking task under the Core ownership lock. Lease/health and guide/query
serving start independently of initialization. Notification observation waits for
successful initialization. Reads and writes for a preparing index owner return
`INDEX_NOT_READY` with retry guidance; unrelated owners remain available. Shutdown
cancels reconstruction at a batch boundary and joins the worker before releasing
Core ownership. Per-key updates maintain observing, reconciliation,
dormant, pending-delivery and retention partitions, and the latest resumable scope
per source/thread. Ordered deadline queues supply due work. Completed history is
absent from recurring observation and delivery passes. Native events, selected
reads, binding writes, rollout files, execution records and writer-lock changes
wake affected keys. A successor also wakes its predecessor. Observation captures
file stamps before reading and validates them after installing evidence watches.
Historical reads use the read-only app-server; owner discovery is limited to
active turns, pending interactions and changed evidence.

Producer writes publish changed paths synchronously. Notification watchers suppress
in-flight own writes and matching published stamps, and exclude derived directories
and unrelated neighbors. Only semantic delivery changes wake delivery; observation
output does not requeue its own observer. Top-level observation timestamps and
receipt update timestamps alone do not rewrite canonical files. Filesystem watches cover
external writes. Watch failures expose a coverage gap and repair at most 64
candidates per batch, including directory discovery. Repair has its own cost owner;
normal ticks never use a full-history repair path.

Reconciliation has three unsuccessful attempts per unchanged evidence revision.
Exhaustion exposes `unavailable-after-restart` without manufacturing a task outcome
or deleting pending deliveries. Closed terminal scopes finish pending reconciliation
as `scope-ended` without a native read. Changed evidence or an explicit selected-turn read
can resume it. The latest interrupted origin scope retains unlimited native Resume
eligibility. Settled older terminal bindings gain the existing seven-day retention
when a newer binding exists for that same source and thread. Pending/sending
deliveries still prevent removal. See [Control loop](control-loop.md#72-native-retry).

`runtime_metrics.notificationObserve` exposes `currentPass`, `lastPass` and
`totals`. Each sample includes `completedPasses`, `bindingsScanned`, `bindingsReused`, `historyReads`,
`ownershipDiscoveries`, `pendingReconciliations`, `reconciliationExhausted`,
`retiredBindings` and `unattributedBindings`. History reads count complete native
observation attempts, including an active-owner fallback; metadata-only reads are
included in history phase time. Ownership discoveries count actual Desktop
`thread-owner-discovery` calls, including calls inside backend selection and history
reads. Pending/exhausted fields are index-state gauges at pass completion; their
totals sum these per-pass samples, not retry attempts or unique bindings. `completedPasses` is one only after a
successful pass, so partial passes never imply an empty pending set.
`phaseWallMs` records scan, history, process, ownership and ownerDiscovery time.
History time sums concurrent task durations. OwnerDiscovery time is nested in
history or ownership time. These fields must not be summed as elapsed pass time;
the existing work counter reports elapsed pass wall time.

Receipt metadata has a resident derived index independent of the full JSON
cache's source-byte and entry limits. Startup adopts each receipt directory's index.
Changed paths update individual summaries and a bounded revision journal.
Codex and Agent task-record projections consume changed keys and invalidate only
records depending on changed runtime or execution-owner files. Unchanged polls
reuse the same snapshots. A reader behind the journal's coverage rebuilds its
projection from indexed summaries. Explicit receipt reads retain the ordinary
JSON cache and return complete payloads.

Both owners use format version 2 in `.activity-index/` inside their canonical
directories: `notifications/tasks/`, the state root for Codex receipts, and
`agents/requests/`. `current.json` names a generation and its row count. Each
canonical filename has a derived entry containing its file stamp and projection.
Entries are grouped by the first two filename characters into JSON shards. A key
update atomically replaces only its shard. Notification entries retain lifecycle,
scope and scheduling metadata;
delivery payload snapshots stay in canonical files. Receipt entries retain the
existing summary projection. Canonical files remain the authoritative data.

Binding persist/removal and receipt reserve/checkpoint sync a per-key dirty marker
before changing canonical bytes. They sync the canonical write, replace or delete
the derived entry, publish a changed count, and then clear the marker. Scheduling
and watcher updates use the same interruption boundary. One-time source and legacy
notification migrations write a single durable `.activity-index/invalid` marker per
owner before changing history, skip derived directories, and preserve unchanged
canonical files. The marker forces reconstruction until that owner publishes
successfully. A restart repairs dirty keys before exposing the index; unchanged
stamps avoid duplicate decoding. Retention
deletes the derived entry together with its canonical binding. No retained snapshot
keeps deleted entries.

A missing, incompatible or corrupt index triggers reconstruction in batches of at
most 64 canonical paths. Reconstruction groups projections into prefix shards,
writes a fresh generation without per-row fsync, derives resident partitions, and
durably publishes `current.json`. Missing, torn or incomplete shards fail adoption
and rebuild from canonical data. Each owner becomes readable independently after
its manifest and marker retirement are durable. The shared availability gate holds
no filesystem work. Receipt residents have separate owner locks.

Startup retires an existing dirty-marker tree with one rename and creates an empty
replacement. After resident installation releases all owner locks, the same tracked
startup worker reclaims retired trees and obsolete generations, including leftovers
from an interrupted startup. Shutdown joins that worker. This cleanup cannot delay
owner availability.
The loaded rows derive latest scopes and deadline partitions before observation.
Interrupted generations are never adopted. Successful adoption or reconstruction
removes obsolete generations. Versions change when projection semantics or the
stored representation change; incompatible versions rebuild from canonical data.
Startup recovery selects indexed live scopes, resumable scopes, unsettled deliveries
and due retention keys. Pending schedules are recomputed against current controls.
Old notification-layout migration scans bindings only when old-layout files exist.
No SQLite store or additional retention policy is involved.

Queue and notification diagnostic reads retain canonical snapshots in memory and
refresh only paths delivered by the shared file-change watcher. Queue scheduling
keeps a separate runnable set; an empty queue waits for changes. Coordination
message and AX reads reuse typed snapshots until their owner file changes.
Git readers cache parsed packed refs independently of the retained tag count.
Completed coordination descriptors reuse their owner/checkpoint stamps.
Message delivery waits for a dependency change or its next deadline. Watcher
failure exposes a coverage gap and bounded repair work through runtime metrics.
Explicit history pages retain the complete canonical data and existing cursors.

Before listening, Core prepares only source identities/configuration and three
owner gates; it never enumerates retained bindings, receipts, generations or dirty
keys. Source history conversion, legacy notification conversion, output pruning,
index adoption/reconstruction, and execution reattachment run after the listener
and lease service are ready, under the same Core ownership lock. Reads of a
preparing owner return `INDEX_NOT_READY`; health, guide and unrelated queries stay
available. Responses without a verified push destination skip notification state
and executable discovery. Control-state reads skip resident synchronization while
that owner is preparing. Notification, dispatch and coordination recovery wait for
migration.
Shutdown cancels history batches and joins initialization before releasing ownership.

`cost.notificationSeed` and `cost.receiptSeed` report canonical rebuild input.
`cost.notificationAdopt` and `cost.receiptAdopt` report derived entry reads.
Receipt adoption groups Codex and Agent stores into one startup pass. Later reads
reuse residents without reloading persisted shards. Observation timestamps remain
unchanged until observation evidence changes, including writes to other binding
fields. Normal adoption has zero seed bytes. Changed-key crash repair and bounded
watcher repair use `cost.indexRepair`. Derived per-key
writes use `cost.indexUpdate`, separately from canonical projection reads. `caches.notificationBindings.activityIndex` exposes partition
sizes, pending bindings, latest resumable scopes, dirty keys and watcher coverage.
`indexWatches.coverageGaps` counts failed watchers. Counters contain no record keys
or task content. Content-free `Index startup` logs separate canonical reads,
projection, derived writes, repair, resident loading, publication, marker retirement
and adoption time. Source history migration has its own duration.
Coordination startup replay still reads retained owners for
pending transitions using its own uncached path.

The JSON cache uses an ordered LRU index to avoid scanning every resident entry
for each eviction. Diagnostics include hits, evictions, evicted source bytes and
fixed content categories with resident file counts and source bytes. Categories
never expose paths or filenames. The encoded-byte ceiling remains independent
of parsed heap usage.

`runtime_metrics` and local `runtime.inspect` expose content-free process and
retention diagnostics. Instrumentation uses a fixed set of aggregate counters;
it does not retain per-request samples. See [Runtime diagnostics](../reference/cli.md#runtime-diagnostics).

## Native session ownership

Agent runtimes own canonical conversation data. Codex, Claude Code, Pi and other Agents write sessions, transcripts and native history indexes into their native stores. ARC owns credentials, task/account bindings, dispatch receipts, approvals and bounded derived observations used to coordinate work. These scheduling records do not replace native transcripts. Account creation and runtime startup never migrate or delete existing session data.

Codex execution processes share the resolved primary `CODEX_HOME`. The Desktop login is the primary account. Secondary accounts use separate App Server processes with process-local external-token authentication, while sessions, SQLite indexes, locks and configuration remain shared. Secondary tasks cannot be dispatched, opened or handed off to Desktop. A dispatch default is independent of this primary/secondary distinction.

OAuth login and Codex-managed token renewal use credential-only processes under private credential directories. They never receive conversation operations. Execution processes use ephemeral credential storage and delegate token renewal to the selected owner. Credential-process shutdown does not clear execution observations or pending interactions.

`accounts/codex_config.rs` tracks revisions of native configuration and referenced instructions/resources without publishing account-home copies. Unchanged content keeps its revision even when assets are re-extracted. An idle execution process can reload a changed revision. Active processes keep their connection for reads and interrupts and defer new dispatch until reload is safe. Credential and session writes do not change the configuration revision.

Claude credential configurations expose the native `projects` directory through a directory link (a junction on Windows). They do not hold separate transcript trees. Existing nonempty private project directories require an explicit migration; ARC never replaces or deletes their contents automatically. Pi uses its native default or its native session-directory environment override; ARC supplies no private session directory.

## Claude login profiles

Core owns Claude login profiles through the local-only `claude.accounts.*` management operations. Settings exposes a browser selector, official login, identity refresh, re-login, and removal. Browser discovery runs on the Core host. The default choice uses the system URL handler; explicit choices resolve installed applications without accepting arbitrary executable paths from the renderer.

Each profile receives a UUID and a permanent `claude-accounts/<id>/config` directory before login. Login, status, and logout use that credential configuration as `CLAUDE_CONFIG_DIR` and their working directory. Its `projects` entry resolves to the shared native transcript store. Child environments remove inherited provider, credential, browser, and configuration overrides and apply ARC's network settings. They do not modify the parent environment or the user's default Claude configuration. Claude Code owns refresh. System-login import copies only the Claude OAuth credential and account metadata into a new profile; credential values never enter management responses, process arguments, or logs. macOS uses a separate Keychain item keyed to the NFC-normalized profile path; Windows and Linux use the CLI credential file in the private profile directory. Import reuses an already signed-in matching account and organization. It verifies the copy through the official CLI before publishing the profile. The copy retains the original OAuth grant; independent storage does not create a separate server authorization, so upstream revocation or refresh-token rotation can require re-login. macOS Keychain entries are tied to the profile path, so directories must not be renamed after login.

ARC runs `claude auth login --claudeai` with its Core executable as the browser handoff helper. The helper captures an official HTTPS authorization URL into a private transient file. The login worker opens it in the selected browser, accepts an optional authorization code through stdin, and confirms the resulting identity with `claude auth status --json`. Profile records contain only public identity fields and their observation time; credentials stay in the CLI credential store. Browser cookies are separate from CLI profiles; the user chooses the intended account on Claude's authorization page and checks the identity returned to ARC. Login URLs are cleared when the flow ends. CLI output and submitted codes are not logged.

One interactive login runs at a time, while any number of completed profiles remain stored independently. Cancel, a ten-minute timeout, and Core shutdown stop the login child. Incomplete profiles remain available for re-login or removal. For profiles created through browser login, removal first runs official logout, then removes local configuration; failed logout retains the profile. Imported profiles retain their shared-grant origin: removal deletes only their local credential, and re-login first detaches that credential before starting official login. This prevents the CLI from revoking the system login through the copied refresh token. A successful independent login clears the imported origin. Stored identity is a last-observed CLI result, not a live authorization or cloud-delivery guarantee.

Local `claude.accounts.routes`, `claude.accounts.route`, and `claude.accounts.send` operations manage target-to-profile routing. Settings exposes only ARC profiles and a notification dialog for each account. On first setup it imports an available system Claude login. The System default tag identifies the profile matching the current system CLI identity; it is refreshed while Settings is open. An explicit Import system login action retains a new system identity after a system account change or profile removal. Control-source routes live on source-owned notification targets, keyed by source and normalized cloud-session ID. `notify_control` exposes safe profile identities and route reads/writes only for an already owned target; bind and verify accept an explicit profile. Existing explicit host routes seed source routes. Verified legacy destinations without an explicit route are pinned to their previously used imported profile during migration. Changing a source route resets its handshake and cannot alter another source's route. Import migrates the former `default` assignments to that profile UUID. Subsequent system logins never alter saved routes. Unrouted binds perform bounded read-only GET requests to the official `/v1/code/sessions/<target>` endpoint using each isolated profile's existing credential after native CLI refresh. Only an exact matching session response counts as visible. Exactly one visible profile, with no unknown probe results, is recorded before verification. If no profile is confirmed visible, ARC SHOULD select a candidate matching the calling source origin `accountId` and proceed with the challenge; reachability remains unverified until `notification_ack`. Without that match, or when visibility remains ambiguous, ARC returns `ACCOUNT_SELECTION_REQUIRED` with safe candidate identities and a control-source continuation. No challenge is sent during selection. The upstream session lookup is an internal Claude Code contract; unsupported responses require explicit selection unless a candidate matches the source account, and this adapter must be updated if the native contract changes. An assigned missing profile fails without fallback. Removing a profile retains its assignments so queued notifications cannot silently switch accounts; explicitly replace those routes to recover.

Manual notifications, reachability handshakes, and scheduled notifications use the same account command builder with an isolated child environment and ARC network settings. Manual send establishes an unassigned route and refuses a different existing assignment; explicit route editing replaces it. The manual send pins its selected profile for the entire request, including concurrent route edits. The CLI response must report `ok:true` and the exact target session. Manual sends are attempted once; an uncertain result requires checking the conversation before retrying. The CLI requires a `session_` or `cse_` ID. A normal Claude Chat can receive notifications when it has a `workspace_session_id`. A `/chat/<uuid>` URL is not that identifier; resolve the workspace ID from upstream evidence before routing. A conversation without a workspace ID has no known CLI destination.

## Ingress and authentication

Each ingress owns its lifecycle lock, listener, provider process, temporary directory, URL, verification challenge, logs, and errors. Stop/failure affects only that ingress. The front door stops ingresses on explicit ingress shutdown or uninstall. Core shutdown closes only its business owners. All ingresses share project and task space. Ingress names are not authenticated users.

A running ingress owns a two-second health supervisor. It probes managed providers and performs cleanup and recovery without UI activity or status requests. Stop, removal, failed startup, and ingress destruction cancel supervision. Status reads report observed provider health and never restart a provider. Cloudflare uses HTTP/2 and its own edge reconnects first. After a previously ready provider remains unavailable, ARC restarts it with 60–300-second backoff; two stable minutes reset consecutive attempts. Lifetime restart count and degradation/recovery timestamps remain available separately. The provider remains a front-door-owned child across Core replacement. Providers and ingress helpers publish PID and creation-time indexes under `<state>/front-door-children/`. Core-owned MCP stdio servers, authentication helpers, disposable Codex proxies and direct Agent fallbacks use `<state>/core-children/` before their handles are returned. With `core.lock` held, startup reclaims process trees belonging to a dead Core before starting Core-owned children. The front-door lock owner independently recovers its own provider children. A reused PID is never signalled; failed reclamation blocks replacement startup. Detached Codex servers and task-hosts are excluded from this registry. This recovery applies on macOS, Windows and Linux, including detached daemons outside systemd.

HTTPS ingress observations use the retained diagnostic log. Each parsed HTTP request records receipt, MCP dispatch when applicable, response headers, and response completion or cancellation. Locally generated trace and connection IDs correlate phases; a syntactically valid Cloudflare Ray ID is diagnostic metadata, never authentication. Records contain route categories, known operation names, valid UUID request IDs, status, duration, and produced bytes. They exclude URL/query strings, credentials, arguments, and response content. Connection parser errors, header timeouts, and capacity rejection have connection-level records. A dropped response does not prove a client received any output. A missing ingress record alone does not establish an upstream failure.

Each ingress instance exposes request counters in status, including in-flight requests, HTTP errors, body timeouts, dropped responses, and aggregate duration/bytes. Counters reset on front-door restart or ingress recreation. Retained events survive Core restart under the existing seven-day/16 MiB log budget. Current errors and historical tunnel errors have separate fields; historical errors retain their observation time after recovery.

OpenAI Tunnel uses official identities and clients. Its stdio adapter forwards to local management using ARC_NATIVE_PORT, ARC_NATIVE_TOKEN, and ARC_INGRESS_ID. Each HTTPS ingress exposes MCP and OAuth routes on its own listener. A tunnel or reverse proxy terminates TLS. Listener creation fixes the ingress. Requests cannot select another ingress through headers or parameters.

The management API binds a random loopback port and validates Host, Origin, and a private token. Authentication data lives in the protected state directory. Remote HTTPS does not expose management. OAuth, Bearer, None, and OpenAI authentication follow ingress configuration. [OAuth](../reference/oauth.md) owns protocol details.

Control-source MCP tools are fixed as guide/query/act. catalog.tools stores frozen definitions. catalog.ops stores operation schemas, examples, and descriptions. toolExposure stores groups, presets, dependencies, and advanced flags. Op allowlists constrain both discovery and execution. Local management retains the full op set. The transport unwraps requests into the existing validation/execution chain. egress attaches the catalog hash arcVersion to all results. Origin carries ingressId, sourceId, controlSource (the source product), sourceLabel, and authType through receipts and background work without changing task ownership.

Core stores stable control sources in `sources.json`. The store is loaded into memory after startup migration and reconciliation under the state lock. Reads use the cache. Durable mutations serialize through an async gate and save on the blocking thread pool, without holding the cache lock during I/O. Unchanged status reads do not write. Activity updates `lastSeenAt` in memory immediately; each source persists that timestamp at most once per 60 seconds, including when other fields are saved. OAuth authentication returns a grant principal; other ingress authentication returns an ingress principal. Core resolves the credential anchor to a source before dispatch. Non-OAuth ingresses have one source; the built-in local CLI has a local credential. Ingress configuration supplies an initial product default, while source product metadata governs per-product behavior, including wait limits. A relay never becomes the calling product.

Consent reserves a disconnected source, with no connection timestamp, for the pending grant. When another source of the same product exists on that connection, the owner must choose `new` or an existing source ID. After successful PKCE validation, token exchange moves the chosen anchor and revokes the previous grant. Source IDs and historical labels survive reauthorization, refresh rotation and disconnection. Disconnection revokes source access and retains the record; non-OAuth disconnection also stops its connection. Source updates, claims and disconnections are local management operations, not control-source MCP tools.

After acquiring the Core lock and migrating the runtime directory, startup performs the one-time [source migration](remote-link.md#migration). It reads `ui-preferences.json` (`values["arc.approved-source-labels"]`), which owns frontend preferences; `app/preferences.json` owns runtime settings. It persists source identities before rewriting owned provenance, notification and response-token state, removes the migrated preference, then commits migration version 2 only after notification migration and row decoding succeed. Version-1 stores run the repair without replacing source IDs or renamed labels. Interrupted migration resumes with the same IDs. Only an ingress with exactly one source can attribute an old ingress-only record. Ambiguous records stay unattributed and cannot deliver notifications or authorize responses. Unattributable subscriptions, governance controls and respond tokens are removed. Unattributed bindings and dispatch history remain inert; active queue rows fail with `source-unattributed`. Notification loading skips malformed rows individually. Migration-generated product/date labels receive numeric suffixes on collisions within an ingress; exact legacy defaults are also repaired in version-1 stores, while renamed labels remain unchanged. Startup reconciles abandoned memory-only consent reservations as revoked.

## Task ownership and execution

New Codex tasks execute in Desktop by default. Disabling auto-open sends new tasks to ARC App Server without migrating historical tasks. Linux always uses background App Server. Explicit send/resume first navigates to unloaded Desktop threads and waits for an owner. Only confirmed absence of an owner after waiting permits ARC App Server to resume the same thread. It never creates a replacement thread. Disconnection, timeout, or uncertain submission never causes a second dispatch. Background sends resume only notLoaded threads with excludeTurns and append input to active turns.

Seed creation persists native state by setting a title. Without a title, it uses the first 120 characters of the prompt's first nonempty line, or ARC task without text. An independent App Server reads metadata before handing off to Desktop. This does not depend on rollout paths or file size. Seed failures are archived before the creating process exits. Later confirmed creation failures are archived only when no turn exists. Receipts retain cleanup results, failure phase, and each seed step's duration.

Control shares Desktop IPC using macOS Unix sockets or Windows named pipes, checking user, owner, and response origin. It reconnects on demand. Owner changes or disconnects clear snapshots. Cached snapshots last at most four seconds and share immutable parsed state with concurrent readers. Eviction releases the cache reference; an in-flight reader retains its history until that read finishes. Accepted frames release their encoded input after parsing, and repeated revisions reuse the cached state. The cache retains at most 64 entries and 32 MiB of encoded frame sizes, except one supported oversized frame; this is not a bound on parsed or in-flight memory. Sending performs a lightweight read, chooses steer/start, and reuses actual task configuration. Windows discovers the current user's Store Codex CLI and caches runtime files by content hash.

ARC App Server is detached from Core. Each Codex profile runs one `codex app-server --listen unix://<state>/codex-app-server/<profile>.sock` in its own session and process group. Under systemd, a transient user scope separates it from Core's service. Windows uses a new process group with job breakaway when available. A copied ARC launcher publishes the index before executing Codex. On Unix, exec preserves the recorded PID and creation token. On Windows, the recorded launcher retains the server in its own Job Object and reaps it. Core waits for the index acknowledgement before releasing the launch barrier, then checks socket readiness. Core keeps an index containing PID, process creation token, socket, executable stamp and inherited limits. Its disposable `codex app-server proxy` child carries the native WebSocket protocol over stdio. Socket readiness requires a connection, including the WebSocket handshake through the proxy on Windows.

Core startup reconnects to recorded servers. Adoption requires a live PID and matching creation token. Configuration changes do not affect adoption or interrupt running turns. Codex reloads configuration and global instructions for new threads; its skills watcher invalidates cached skill catalogs. ARC keeps one server per profile and routes existing-thread operations to it. An adopted server resumes loaded non-idle threads with `excludeTurns`. Codex re-sends pending requests with connection-local response IDs, including string IDs. Secondary profiles refresh external tokens through `account/login/start` before resubscribing. Execution uses the shared native `CODEX_HOME` and ephemeral credential stores; authentication RPCs, seed readers and primary-account quota readers remain short-lived stdio processes. Secondary-account quota reads use their profile server without checking configuration fingerprints. Native history remains authoritative for output produced without a Core connection. An idle server whose executable changed is replaced. An unreachable live server is retained and the connection error is reported.

Core marks a shared launch barrier closed before cancelling startup, observers or requests. New and queued spawn/adoption paths fail with `CORE_SHUTTING_DOWN`; already admitted launches finish publishing their indexes before cleanup proceeds. Cleanup also stops newly created hosts whose startup was cancelled before Core cached the connection. Core shutdown stops idle Codex servers and disconnects from servers with non-idle loaded threads, pending connector requests or failed observation connections. Explicit profile closure and uninstall stop recorded servers. A server retained on final Core shutdown can finish its turns and remain idle until the next Core connects. External-token refresh requests still require an attached Core.

Pi/ACP and stream-json tasks use a detached `arc task-host` per process. Core indexes each transport and projects its events; the host owns Agent stdin/stdout and reaps its exit. The executable is copied by content hash into `<state>/task-host/<hash>/` before launch, allowing Windows installation to replace the application files. Startup removes obsolete executable versions only when no live indexed host uses them. Unix hosts use `setsid`; Linux services first try a transient user scope. Windows hosts join their own `KILL_ON_JOB_CLOSE` Job Object before spawning the Agent, so descendants inherit that job independently of Core. Native Agent stores remain the canonical session and history stores.

### Task-host protocol v1

Protocol v1 is frozen. Local connections use a Unix socket or a Windows named pipe with newline-delimited JSON. The client sends `{"protocol":1}` and the host replies with `{"protocol":1}` before accepting one command. Each command receives one JSON reply. Errors use an `error` string with an actionable code.

| Command | Fields | Result |
| --- | --- | --- |
| `status` | `op` | `protocol`, `agentPid`, `alive`, `exitCode`, `receivedSequence`, `firstOffset`, `nextOffset` |
| `write` | `op`, `sequence`, `frame` | Status after writing the JSON frame plus newline to Agent stdin |
| `signal` | `op`, `signal: "interrupt"` or `"kill"` | Status after signaling the Agent tree |
| `close` | `op` | Status; closes stdin, allows a two-second graceful exit, then ends the tree |

Input sequences start at one. Duplicate or earlier sequences return the existing acknowledgement without another stdin write. A sequence gap returns `TASK_HOST_WRITE_GAP`. Core persists the input intent before transmission and reconciles uncertain writes with `receivedSequence`; it never blindly repeats an uncertain prompt. Agent protocol replies remain authoritative for acceptance and turn completion.

The bounded 64 MiB delivery journal contains newline-delimited `{"offset":N,"kind":"stdout","frame":"<stdout line>"}` and `{"offset":N,"kind":"write","frame":{"sequence":N,"value":<input>}}` records. Offsets are monotonically increasing record sequences, preserved through compaction. Readers ignore an incomplete final line. An expired replay offset produces `TASK_HOST_JOURNAL_GAP` and requires native-history reconciliation. An encoded record larger than the journal limit ends the transport with an explicit error. The host writes an exit record containing its final status, exit code, journal range and any stdout error before exiting.

Task state keeps `taskHost` with `hostPid`, `hostStart`, `socket`, `journalPath`, `ackedOffset`, `agentPid` and `hostProtocol`, plus input acknowledgement and launch identity metadata. Core startup checks process identity, replays from `ackedOffset` into the Timeline, rebuilds unanswered interactions and settles recovered native replies without the original waiter. Replay offsets, pending interactions, output and Timeline checkpoints persist together. An exited host with an exit record supplies the real exit outcome. A missing host without that record retains the unknown/reconcile path. An unknown host protocol is drain-only: read its journal, signal its indexed process or await exit; do not send new inputs.

Core shutdown disconnects from hosts with an active turn or pending interaction and closes idle hosts for inexpensive native resume. Once a turn has ended and no Core heartbeat has arrived for 30 minutes, the host closes Agent stdin and exits after its graceful shutdown period. Local uninstall uses a one-time filesystem capability bound to the running Core PID and creation token, waits for Core cleanup, then stops every recorded Codex server and task-host. Ordinary CLI clients retain the Desktop-only restriction on update shutdown. Normal update and restart use the same shutdown policy; no task continuation is submitted automatically.

When detached startup is unavailable, Codex and task transports log a WARN and fall back to the direct stdio child. This degraded transport follows Core's lifetime and cannot provide crash continuity. Test fixtures keep direct stdio unless they explicitly exercise the task-host protocol.

Pi/ACP stdout tolerates non-JSON lines. Task state exposes `stdoutDiagnostics`, a redacted ring capped at 4 KiB and 32 entries (up to 1 KiB per entry), with a skipped-line count and truncation flag. Abnormal exits include this ring in the task error. A read failure or line exceeding 32 MiB records an actionable task and Timeline error. Detached journal failures preserve the unknown/reconcile boundary when output is incomplete.

In-memory state, Timeline updates and live events remain immediate. Pure ACP message/thought chunks and Pi text/thinking/tool-call argument deltas checkpoint within one second of the first unsaved delta. Structural events and control operations persist immediately. Detached journal replay restores deltas after an abrupt Core crash; direct stdio fallback can lose the uncheckpointed window. Persistence failures surface as `storageError`. Clean detach stops the reader at a frame boundary and flushes its final snapshot. Catalog snapshots update on initialization and actual configuration changes. Late events cannot reopen a terminal turn; a new turn requires an explicit start.

## Conversation projection

`task_tracking::Timeline` owns conversation entries and activity presentation. Live ACP/Pi events, native Claude transcripts, Codex app-server items/history and Codex rollout framing converge on its text/tool/notice converters. `agents/activity` caches bounded transcript projections and discovers external sessions; it does not maintain a second phase/headline parser. The metadata clock streams every complete transcript line from offset zero on its first scan, then reads only appended bytes. It feeds one record at a time through the same converters and retains metadata rather than transcript contents. Truncation resets the clock. Native Pi history selects one parent-linked branch before conversion. Claude sidechains are omitted with an explicit coverage count.

Tool input normalization supplies common command, paths and edit excerpts without removing native evidence. Non-terminal notices retain retry/compaction/warning facts without changing turn status. Pi attempt errors settle only when the native agent_settled event establishes the outcome. The frozen MCP tools and notification envelope do not change; the existing timeline/activity operation outputs carry these fields. See [Task tracking](task-tracking.md#lifecycle-notices-and-tool-inputs) for fields and bounded coverage.

The task panel can show a bounded preview of a completed Codex turn before loading earlier history. The preview has no live timeline cursor. Scrolling toward the start, a non-scrollable preview, or renewed live activity triggers a complete read. The rollout metadata scan runs outside the shared timeline lock.

Final-response delivery is a separate native text buffer: its per-turn replacement/append semantics and ACP 256 KiB tail truncation must not be replaced with redacted, head-truncated Timeline text. The event archive remains authoritative for complete protocol evidence.

## Receipts, observation, and notifications

Writes reserve an idempotent UUID receipt before dispatch. Repeated IDs with identical arguments read the original operation. Conflicting arguments are rejected. Request timeout returns pending. Connection loss after submission returns unconfirmed. Both retain original identifiers for readback.

Codex interruption snapshots are reconciled against top-level terminal records in the native rollout for the selected thread and turn. Embedded tool output, another turn's terminal and inherited subagent history cannot confirm that interruption. A recorded completion corrects a stale interrupted snapshot; unavailable terminal evidence leaves the interruption unconfirmed. Native rollout ordinals preserve terminal ordering through the shared lifecycle authority. Delivery labels and event kinds retain the queued outcome. A later native conflict holds new pushes while previously attempted events remain readable through explicit inbox queries and delivery diagnostics.

Receipt storage reads preserve recorded provenance. Management and control-source response boundaries project current source and account labels once over the complete result. Label projection uses the in-memory source snapshot and one account-index read per response; it never reconciles source identities. Task and status scans therefore do not multiply account-store reads by receipt or source count. Each response takes fresh labels, so renames and account removal appear on the next read without a persistent label cache.

The desktop task list polls a revisioned snapshot. Unchanged polls return only the revision. A client one revision behind can apply a bounded set of upserts and removals. A missed revision or a larger change returns the complete list.

Core's local JSON read cache validates file identity, modification time and size before reuse. It retains at most 8192 files and 32 MiB of encoded file sizes per cache; parsed values can use more memory. Atomic saves and receipt reservations invalidate the changed record and update known directory entries. External directory changes trigger enumeration on the next read. Task projections and the notification binding snapshot reuse unchanged owning directories; these stores must continue to replace records atomically. They do not cache upstream execution or authorization decisions. Notification binding writes publish parsed values under the store lock. Routing with a known turn reads that binding directly. Continuation and handoff processing reads shared history only when required, and unchanged subscription state is not rewritten. Identical bindings are not rewritten. Task observations and ownership snapshots persist only semantic changes; a top-level `observedAt` change alone is not a durable transition. Persisted `observedAt` therefore identifies the last stored observation, not a background heartbeat. Live ownership queries retain their current observation time. Nested handoff timestamps and all state, owner, error and reconciliation changes remain durable.

Activity sampling checks external transcript metadata at its existing two-second cadence. Unchanged directories, recent transcript tails and the Codex title index are reused. The content tail and lifecycle clock read the same sampled byte range. Concurrent appends are picked up on the next pass. Replacement or truncation resets the cursor. Codex activity uses the complete incremental lifecycle clock even when the bounded content tail is empty. Silence does not expire an unfinished turn. The tail cache retains up to 128 recent files; oversized working sets can evict cached data. Writer-lock probes remain live because lock ownership can change without changing file metadata.

Guide index entries and per-operation guides disclose retry semantics. Receipt-backed callers generate and retain the UUID before the first write; a server-generated ID cannot protect a retry if the original response containing that ID was lost. Receipt decisions refer to the original operation. Non-receipted controls, screen actions, and context-provider amendments require state readback before retrying a side effect. An act envelope or idempotent annotation does not establish durable replay protection. ARC never automatically repeats an unconfirmed external write.

waiter combines event wakeups with real state checks in default 30-second segments. Cancelling a wait only releases the wait, not the task. Codex retains its owner. Pi/ACP use live process state. Waiting holds no global lock and never resumes stopped execution processes. ARC App Server waiters read metadata and paginated turns through the selected turn without the old full-history interface.

claude_notify persists per-thread/turn bindings, actual dispatch origin, and delivery records. governance stores per-target token buckets, recent batches, reachability handshakes, and reversible thread/target notification controls. It does not classify task loops. One scheduler handles all events. needs-input and approvals skip only the 30-second coalescing window and still consume tokens. Observation and sending are separate. Delivery passes claim only due binding keys. Each claimed key leaves the queue or receives a strictly future attempt; errors retain a bounded retry. Unbound deliveries park until their binding or subscription changes. Native outcome conflicts and unconfirmed outcomes park until new evidence; backoff and batch windows retain their own attempt times. Target maintenance has a separate clock for token refill, retained batches, subscription expiry, secret rotation, reachability challenges and escalation. It never supplies a binding's retry time. Effective subscription, thread and target changes wake only indexed dependents. Binding and routing file events identify affected keys; watcher revisions and output-file stamps do not invalidate all pending work. Idle wakes read no binding history. Subscription-store stamps and external settings invalidate cached maintenance deadlines. A pass preserves concurrent changes for the next wake. Record locks are released during network requests. Retries back off exponentially from 10 seconds to 5 minutes, retaining token eligibility and eventId. Mute, hourly digest, rebind, and breaker affect only notifications. Queries, controls, inboxes, subscriptions and target token buckets are source-isolated. Breaker or sustained token starvation produces one local system escalation, reset after recovery. Delivery timing records queue reasons and elapsed times. CLI acknowledgement does not prove receiver display. Answered interactions cancel unsent notifications. Unfinished bindings and pending deliveries remain. Success requires Claude CLI JSON ok=true and the same session_id. See [notification contracts](../reference/tools.md#control-source-notifications).

## Data and observation

Projects come from native project/list. ID/name resolution caches for 30 seconds. Workspace and filesystem rules resolve paths. Review views enforce resource boundaries. Git baselines capture pre-submission HEAD and dirty status. Turn comparisons describe the current workspace, including pre-existing changes.

kernel::results stores immutable large-result snapshots with UTF-16 pagination. Pi/ACP native events use an active JSONL tail and verified gzip segments. Codex owns its native history. User logs and event archives are separate. [Tools](../reference/tools.md#output-events-and-logs) owns budgets and retention periods.

## Desktop lifecycle

- Connect starts the selected ingress and provider. Agent execution connections initialize on demand.
- Stopping a remote connection tears down only its listener and provider. Disconnecting a source revokes its authority. A local source can also stop its own bridge.
- Closing the window hides it. Tray and connections continue.
- Core persists explicit connection start and stop intent in desktop-session.json. Runtime cleanup and failed restoration do not overwrite that intent.
- Quit releases the Desktop lease. Other leases may keep Core alive.
- The first Desktop lease in each Core generation restores expected remote connections. Local bridges attach on demand. Connection intent survives restart and excludes explicitly stopped, disabled, or deleted connections.
- Desktop handles Core stop and recovery through local IPC even when Core cannot respond. Explicit stop fences automatic starts across local entry points until Start Core. Recovery verifies process identity and waits for the prior Core lock to release before replacement.
- Update verifies signatures, requires other entry points to exit, drains requests, suspends auto-start, and waits for the Core file lock before installation. Failure restores clients and connections.

Tray left-click opens the main window. Right-click opens a native menu without another WebView. Platform implementations own screen capture and native windows. Linux returns explicit unsupported results.

## State and build boundaries

The state directory is agent-remote-control. Both development entry points use installed data by default. The development supervisor builds both binaries, quits the current Desktop through local management, and waits for Core to exit before taking ownership. It preserves the Core lock and build checks, keeps Vite running across successful rebuilds, and restores the installed Desktop on exit when it performed a takeover. Explicit ARC_STATE_DIR selects temporary acceptance data. Identities, environment variables, and deep links retain no old aliases or automatic identity migration. app/ stores preferences.json and native.json runtime metadata. After acquiring the state lock and before reading metadata, Core renames legacy web/ to app/. If both exist, it retains app/ and removes web/. Production, -dev, and -preview share this startup path. Packages contain native executables and static resources only. Node/npm are build tools. CLI guide and catalogs are embedded at build time and require rebuilding after edits.

## Permissions and readiness

Core aggregates read-only permissions status for CLI doctor and overview. arc-screen status checks Accessibility and Screen Recording. Tools only preflight and return structured PERMISSION_REQUIRED when missing. Explicit requests originate from Desktop's permission page through helper request. Core heuristically opens the FDA-protected TCC database without reading content. command separately performs a zero-byte read through Codex app-server command/exec. Unknown never means granted.

Desktop queries UserNotifications. Only a user click requests authorization. Core's notification fallback uses the existing authenticated Desktop channel to request permissions/notify. Offline Desktop or missing permission only logs the failure and never invokes osascript. Login startup checks LaunchAgent and launchctl print-disabled. Ingress verification reuses diagnostics. Claude reuses CLI discovery and auth status. Codex login reuses account/read.

The permission page refreshes on window focus and manually. System Settings navigation remains local to Desktop without new MCP tools.

Packaged Desktop's startup chain attributes Full Disk Access to ARC App. Core and its Codex app-server child inherit that identity. A terminal-launched Core may inherit terminal identity and cannot prove App readiness.

SubscriptionService schedules provider quota reads and stores enabled state and refresh intervals. Agent participation determines sources automatically without saved source selection or fixed windows. Homepage rings use upstream weekly quota. Details retain other windows. Providers own native credentials and upstream responses. Successful readings cache under subscriptions/readings and restore as stale. Failures back off. Expired windows hide. Desktop subscriptions:changed and browser /api/subscriptions/events share snapshots. Legacy cache history is removed on read. Local usage, token aggregation, and prices are no longer collected.

Desktop interactions reuse thread IPC snapshots and change broadcasts with a two-second observation fallback. Asynchronous questions match accepted question-reply messages by original questionItemId. codex_respond sends native Desktop reply text for asynchronous questions. Approval, input, and elicitation responses use the corresponding follower interface with the original execution owner, then confirm disappearance. Identity verification and unpublished response paths only notify and direct the user to Desktop. ARC neither takes ownership nor auto-approves.

`dispatch_queue` persists pending parameters and separate dispatch receipts. Per-thread write locks protect checks and submission. Notification-observer capacity recovery starts another turn only for serverOverloaded failures without tool activity. Both use durable requestId to avoid blind resubmission after Core restarts. `respond_tokens` supplies expiring source-isolated aliases for original interactions without replacing owner validation.

`claude_notify/continuation` recognizes Desktop native retries in the same observation chain. It requires a failed/interrupted predecessor, adjacency in snapshot and persisted history, a known retry trigger, no new user message, complete native turn configuration, and an open thread+origin binding for interrupted-task resumes. Capacity retries require a successor start within ten minutes after predecessor termination. Recognition can occur after restart downtime. Native environment scaffolding is distinguished from new user content. It first idempotently records native-retry/retryOf in dispatch_policy, then inherits source identity, connection diagnostics and notification binding. The new turn shares terminal notification, review, and history paths. New content or insufficient evidence prevents inclusion. No independent poller is added. See [native retry](control-loop.md#72-native-retry).

### Request routing presence

`claude_notify::routing` owns per-request notification routing, separate from native
response ownership. Request ingestion records presence once before exposing pending
state. The desktop detail reports focused/visible presence every two seconds through
`tasks.presence`; a six-second lease prevents stale window state after a crash.
Only the local management surface accepts presence reports. Request routing mutations
use `request_route` with source ownership checks, or local `tasks.request-routing`.

Persisted routing includes a process incarnation and paused remaining time. A new
Core incarnation removes old delays before delivery. The notification scheduler
refreshes routing before eligibility and token charging. Pending reads, progress and
inboxes project the same routing record. Native resolution closes routing without
requiring the user to participate. The dock has no countdown animation; polite
announcements cover state transitions and the final five-second interval.
