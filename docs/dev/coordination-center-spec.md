# Agent bulletin and activity

MUST means a requirement. SHOULD means the default unless a concrete task-specific
reason justifies an exception. MAY means an option.

This specification defines the target product model for the Agent bulletin. The
[coordination reference](coordination.md), current source and current catalog remain
authoritative for implemented operations. This document does not change their
contracts. The desktop follows the shared [UI conventions](ui.md).

## Product outcome and audience

Agents use the bulletin to establish shared context: what is happening, which
resources have declared users, what needs attention, and what changed since their
last observation. Agents publish and maintain their own coordination notices.
Humans can observe this context on the homepage and inspect its owning records.

The product has one public entry, **Board**, with two views:

- **Current** presents current work, advisory resource declarations and outstanding
  matters from their domain owners.
- **Activity** presents observed changes from the bounded `events` journal.

Attention is a filter of current matters. It is not another inbox or task store.
The desktop defaults to read-only observation. Agent publication and domain actions
form the primary workflow.

## Information model

| Information | Canonical owner | Meaning and lifecycle |
| --- | --- | --- |
| Running work and execution state | Existing task/activity owner | Observed execution, with its task and turn references. |
| Work intent and temporary public notices | `coordination::bulletin` | Source-reported context maintained by its authenticated owner. |
| Resource declarations and resource blockers | `coordination::bulletin` | Advisory claims and explicit conditions; never resource locks. |
| AX candidates and confirmed AX entries | `coordination::ax` | Candidate confirmation, triage and resolution retain their native lifecycle and authority. |
| Task questions and permission requests | Existing interaction owner | An outstanding request with its actual responder and permission boundary. |
| Connection, notification or update problems | Existing connection, notification or update owner | Current unresolved conditions with an available owning diagnostic or corrective surface. |
| Recent changes | `coordination` journal | Historical observations referring to canonical records. |
| Addressed requests between sources | Existing `messages` owner | Source-visible inbox/outbox content and negotiation state. |

A notice changing state can appear in Activity while its latest state appears in
Current. Both refer to the same canonical notice. Activity does not own resolution.
Current does not copy the event journal into another history store.

The bulletin MUST reuse registered resource identities.
A resource declaration MUST remain advisory.
A task reference MUST retain its task, turn and source association.
A failed task MUST retain its execution outcome when an associated notice closes.
A closed notice MUST NOT resolve an AX entry or another owner's outstanding matter.

## Agent read/write loop

### 1. Read shared context

At turn start, after a return from a long-running operation, and before work on a
shared resource, an Agent reads current coordination context. It reads Activity
from its saved cursor when incremental history is useful. It also reads its own
addressed messages when participating in source-to-source coordination.

The existing building blocks are `query` ops `board`, `events`, `ax_list` and
`messages`, plus the relevant task or other owner reads. An implementation may
compose these behind a native read operation discovered through the current
catalog and guide. The normalized current projection MUST be available to Agents
and the desktop through the same native composition. It MUST NOT exist only in
React. Its exact operation schema belongs in the catalog when implemented.

The context includes current work, active declarations, outstanding matters,
observation time and coverage. Detailed records are loaded on demand. It does not
crawl transcripts or start an Agent to build the summary.

The Agent MUST keep independent cursors for each journal filter scope and addressed
inbox scope. Desktop browsing MUST NOT advance those Agent cursors. Cursor expiry
MUST expose the owner's gap and reset contract. A successful read MUST NOT resolve
a matter or acknowledge a notification handshake.

### 2. Publish intent or immediate context

An Agent publishes a short notice when shared work benefits from an explicit
intent, resource declaration or immediate public explanation. Existing running-task
metadata is projected from the task owner. Agents SHOULD avoid repeating task
progress in manually maintained notices.

The existing publication operations are `notice_post`, `notice_update` and
`notice_close`. The source identity comes from authenticated origin. An Agent
updates only records allowed by the native ownership contract. Revisions and
request-ID replay remain the bulletin owner's responsibility.

A general notice needs a concise metadata summary and an authenticated owner.
Resource and task associations are supplied when meaningful. Resource declarations
require the affected resources. An estimated duration, when supplied, is an estimate.
The target general-notice workflow SHOULD avoid mandatory unrelated resource or
duration values. The current `notice_post` contract still requires resources and
`expectedDurationSeconds`; any simplification requires an explicit domain/catalog
change during implementation. Clients MUST use the current discovered contract
until that change lands.

### 3. Act through the canonical owner

The Agent identifies an outstanding matter, checks its current owner state and
uses the owner's existing operation when authorized. Examples include confirming
an associated AX candidate, updating an owned notice, or clearing an owned blocker
with the required recovery evidence.

A task question requiring human input remains a request for that human. A pending
permission request MUST NOT become permission for an Agent to approve itself.
A matter waiting for another source stays attributed to that source. Local desktop
administrative authority MUST NOT be used to impersonate an Agent.

Addressed coordination replies use `messages` and `message_send` under their
existing visibility rules. Public notices are not a substitute for private replies
or required negotiation handling.

### 4. Read back the result

After an action, the Agent reads the owning result or record and refreshes the
current projection. The owner determines whether the matter is still outstanding.
The owner projects a change into Activity through its existing producer path.
The Agent updates or closes its own notice when its declared work scope changes.

A transport acknowledgement alone MUST NOT imply that work completed.
Reading or dismissing a desktop item MUST NOT resolve it.
Clearing a blocker MUST NOT resume a task.
Closing a notice MUST NOT stop linked tasks.

## Outstanding matters and ownership

The current projection contains references to outstanding owner records, never a
second durable to-do list. Each projected matter identifies its canonical owner
and identity, current state, affected resources or tasks, observation coverage,
required actor and available next step. Where applicable, it retains the current
revision and the exact catalog-discovered call or owning detail route.

The required-actor categories are:

- **Agent action**: an existing owner action is available to the reading source.
- **User decision**: the owner requires a human answer, permission or decision.
- **Other source**: progress depends on another identified source.
- **Unknown**: ownership or actionable coverage is insufficient.

These categories report existing owner facts and authorization. They MUST NOT
introduce another authority model or infer permission from labels, accounts or
record visibility. Shared visibility does not grant another source's actions.

| Matter | Read and act at | When it leaves attention |
| --- | --- | --- |
| AX candidate needing confirmation | `ax_list`, then authorized `ax_candidate` | The AX owner confirms or rejects that candidate. Confirmation may expose a distinct triage requirement. |
| Confirmed AX work requiring triage | `ax_list`, then authorized `ax_triage` | The AX owner's applicable requirement is satisfied. Existing Maintainer mode and ownership checks remain in force. |
| Task input or permission | Existing interaction read/respond operations | The interaction owner confirms the response or withdrawal. |
| Failed or interrupted execution | Existing task read/recovery operations | The task owner confirms recovery, an evidenced successful successor or another explicit disposition. |
| Resource blocker | `board`, then authorized `blocker_clear` | The blocker owner records clearance with its required evidence. |
| Connection, notification or update problem | Existing owner reads and controls | The corresponding owner confirms recovery. |
| Due work, including a scheduled AX check | Its actual task or automation owner | That owner records execution, completion, cancellation or rescheduling. |

Candidates MUST NOT be presented as confirmed defects. Historical failures remain
in Activity after current attention is cleared. Receipt stalling alone MUST NOT
become task failure. A stale blocker remains uncleared. An unavailable owner read
MUST NOT produce a complete zero.

Deduplication uses canonical owner identities: task/turn/request, blocker or AX
record. A pending decision is the primary task action when indicators overlap.
Related information can be grouped without merging distinct records or outcomes.
A notice referencing an AX entry or task does not add another attention count for
the same requirement.

A shared count represents distinct current matters in its disclosed scope.
Agent-action counts and user-decision counts MUST remain distinguishable.
An unread event count MUST NOT be used as an outstanding-work count.

## AX collection example

A running AX experience check is a real task. Current shows its known execution
state and owner through a task reference. An optional notice adds the check's
shared work scope or affected resources.

New friction candidates remain AX-owned records. Current can group them as
candidates awaiting the associated source's confirmation. Confirmed entries and
triage requirements retain the AX lifecycle. Activity records the existing typed
AX and task lifecycle observations, referring back to those owners.

A requirement to run a future or recurring AX check belongs to an actual task or
automation owner. A short-lived public notice cannot provide its durable schedule
or completion tracking. This scope does not add a scheduler or promise autonomous
checks, Agent wakeups or notification delivery.

## Freshness, lifecycle and coverage

The projection uses native `lastActiveAt`, `inactivityAgeSeconds`, `observedAt` and
`activityCoverage`. It adds no frontend expiry or heartbeat rule. The current
bulletin owner withdraws inactive notices after six hours and marks inactive
blockers stale. Neither withdrawal nor missing activity proves task completion.
Long-lived pending requirements remain with their canonical owners.

Native rules for linked terminal outcomes, evidenced successors, source revocation
and clock uncertainty remain authoritative. Unknown execution stays unknown.
Existing blocker clearance requirements remain in force. Clearance presents its
recorded suggested next step without submitting task continuation.

Journal and current-owner reads fail independently. A failed refresh retains the
last readable data with an unavailable or stale indication and a retry. Each
projection discloses its observed scope and coverage. Partial or unavailable
coverage MUST remain distinguishable from a genuine empty result.

## Desktop read-only boundary

The Board dialog supports reading, filtering, grouping, expanding records and
navigating to existing owner details. These are observation and navigation actions.
The public Board surface exposes no publication, editing, notice closure, blocker
clearance, confirmation, triage, task retry, resume or approval controls. It has no mark-all-resolved action.

Opening an existing task or settings surface can expose that surface's normal
authorized interactions. The transition MUST be explicit. Those interactions remain
owned by that surface. They MUST NOT be embedded as Board quick actions.

The desktop MUST NOT acknowledge Agent messages, advance Agent inbox or event
cursors, confirm AX candidates, renew another source's activity or change a
resource declaration merely by displaying it. Native read-time reconciliation and
lifecycle maintenance remain owner behavior; they do not fabricate Agent activity.

Any separately needed local administration uses an explicit existing management
surface and authenticated local authority. Administrative forms are not part of
the default Board experience. There is no new administrative UI in this scope.

## Homepage experience

The entire current-activity row below the homepage clock and date opens Board.
There is no Board entry in the bottom-left navigation capsule. The row remains a
single compact trigger. When Studio is disabled, the same activity trigger remains
available at the top of the homepage without enabling Studio's clock or background.
The trigger remains available when there are no active tasks.

Board opens as a shared, bounded dialog. Current is the default view. Activity is a
secondary view in the same dialog. Current groups known work and resource
declarations, resource blockers and outstanding owner actions. Resource and
attention filters narrow the observation. Record expansion shows readable owner,
resource, state and activity metadata, with technical metadata behind disclosure.
Owner-detail navigation preserves the view and returns focus to its initiating row.

Use a quiet list with clear spacing and restrained separators. Avoid decorative
motion, playful effects, dashboard grids and full-height management panels. The
clock, date, ARC mark, task topology, earcup connections and room background retain
their existing layout. No additional homepage shelf or floating launcher is added.

Studio's running and pending-input counts retain their original task-only meaning.
Clicking either count or the space within their row opens Current. The row MUST NOT
silently become an Agent-work, blocker or AX count. A task-input filter in Board
provides the corresponding read-only user-decision scope. No focus timer is added.

Use shared controls and semantic tokens. Use `SingleChoice` for Current/Activity
and other single-choice controls. Support both themes, both languages, portrait
widths, keyboard navigation, layered Escape, focus restoration and reduced motion.
Opening and closing use fades and slight movement of at most 180ms. Background
refresh does not steal focus, jump the reading position or announce the full feed.
Necessary units, constraints, errors and unknown-state explanations remain visible.
Decorative slogans, redundant labels and diagnostics do not become primary UI.

## Implementation boundaries

`coordination` retains the bounded event journal. `coordination::bulletin` retains
notices, declarations and blockers. AX, tasks, interactions, notifications,
connections and updates retain their current ownership and permission boundaries.
The shared native projection performs composition and deduplication. React stores
only bounded read results and view state for the Board surface.

Missing native reads use thin adapters over those owners. No second resource
registry, generic event bus, task engine or resolution state machine is added.
The control-source `guide`, `query`, `act` parameter structures remain frozen.
The single `notification` event and its `{op, args}` outer envelope remain frozen.
Capability changes use catalog operations and guide.

`board` returns `attention` for its reader: owned AX candidates, owned live
blockers, failed notification routes and, in Maintainer mode, due AX triage. Each
item carries `requiredActor` and a read-only `next`. Local authority observes every
owner, so the desktop shows these items as read-only rows. Task questions,
permissions and failed executions are still composed in React from observed task
state; moving them into the native projection remains an implementation target.
The desktop Board is read-only. Agent and authenticated management writes continue
through the existing owner contracts.

## Acceptance targets

Agent behavior is checked through the current public operation boundaries. Desktop
UI/UX is checked with stateful browser fixtures. Concept images illustrate the
target presentation and do not serve as runtime acceptance evidence.

| Scenario | Observable result |
| --- | --- |
| Two Agents share a resource | Each sees the other's declared intent and known work references. Claims remain advisory. |
| Agent read, publish, update and close | Owner identity is captured natively; readback reflects the action and Activity retains its transition. |
| Read only the new changes | A saved per-scope cursor returns bounded incremental history and exposes retention gaps. |
| Task metadata and a related notice | The task's execution has one owner and is not duplicated as an independently maintained task. |
| AX collection finds candidates | Candidates are readable as candidates; confirmation/triage follows the applicable AX authority. |
| Agent action, user decision and other-source wait | The required actors remain distinct and no unavailable action is offered to the reader. |
| One requirement referenced from several places | Current attention counts it once using its canonical owner identity. |
| Owner action completes | Readback refreshes the same Agent/desktop projection; the history remains readable. |
| Human opens, filters and expands Board | No publication, acknowledgement, Agent cursor advance, clearance or execution is submitted. |
| A human follows an owner-detail link | The original task/turn context is preserved; returning restores the Board view and focus. |
| Stale notice, blocker or unknown execution | No invented completion, clearance or fresh heartbeat appears. |
| Future or recurring AX work | Its real owner retains the schedule and outstanding state when a temporary notice expires. |
| Partial, failed and empty owner reads | Coverage, retryable failure and genuine emptiness remain distinct. |
| Enabled homepage in both themes and narrow widths | The activity row opens a bounded dialog, retains the homepage layout and exposes readable metadata without horizontal page overflow. |

## Scope

The target includes the Agent read/write loop, shared native current-state
composition, AX and task references, temporary Agent publications, a default
read-only desktop Board, secondary Activity history and homepage integration.
It excludes a new workflow engine, scheduler, automatic remediation, automatic task
continuation, resource locks, AX triage forms, desktop publication forms, a public
private-message viewer, community workflows and MCP service productization.
