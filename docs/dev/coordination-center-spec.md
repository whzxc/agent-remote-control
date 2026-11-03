# Event center and bulletin board

This specification defines the first desktop coordination workspace. It builds on
the existing [coordination owners](coordination.md) and follows the shared
[UI conventions](ui.md). It describes the implementation target; the coordination
reference remains authoritative for existing native behavior.

## Product outcome

When several tasks run together, a user can find what changed, identify work that
needs intervention, inspect the affected task or resource, and use the existing
action that can move it forward.

The workspace has two views:

- **Events** presents observed changes and links to their owning surfaces.
- **Board** presents current work notices, resource claims, blockers and activity.

An attention filter prioritizes actionable current conditions. Reading an item
does not resolve it. A resource claim stays advisory and never acquires a lock,
grants permission, or changes dispatch policy.

## Entry and navigation

Add one entry to the shared bottom-left navigation capsule. Open a normal workspace
panel with its title bar at the top. Use `SingleChoice` for Events and Board, and
keep the attention filter and available project/resource filter in a compact
toolbar. Start with Events and retain the selected view and filters while the
window remains open. Avoid a new dashboard, separate floating launcher or third
notification panel.

The capsule badge counts distinct current actionable items, not unread events.
Show no badge for zero. Derive the count from the same projection used by the
attention filter. A partial or unavailable observation cannot claim a complete
zero. Use the existing unavailable-state convention instead of a fabricated count.

Rows open the existing task, connection or update surface where one exists. Preserve
the selected task and turn from the event reference. Preserve workspace filters
and restore focus when returning. A missing or inaccessible target remains readable
as metadata with an actionable explanation; do not render a nonfunctional link.

## Events

Use the bounded `events` journal for history. Present the newest observations first
with time, event type, known actor, resource and outcome. Render supplied metadata
as data. Resolve human-readable labels through existing local projections where
available; retain opaque IDs when labels are unknown. Event references do not
grant access to task content.

Keep important transitions visible: task submission and terminal outcomes,
notification failures, stalled or unconfirmed operations, application replacement
and recovery, resource notices and blockers, and registered worktree/Git changes.
Group repetitive observations of the same operation or bound task turn into a
compact expandable row. Preserve the event IDs, ordering, distinct outcomes and
references inside that group. Do not join unrelated tasks by title or actor label.

Current pending input and connection conditions come from their existing owners;
they are not fabricated historical journal records. Show current attention items
above retained history in the same Events view. Do not copy prompts, transcripts,
raw error bodies or private routes into the shared coordination journal.

Use existing task response, retry and resume interactions in the task detail
surface. Connection and update failures open their existing corrective controls.
The event center does not introduce another approval form, message composer,
dispatch engine or automatic retry mechanism.

### Attention semantics

Include an item only when current owner evidence identifies an outstanding action:

- An answerable, unsubmitted task question or permission request.
- A current failed or interrupted task with an available inspection/recovery action.
- An uncleared blocker, including stale or uncertain blockers.
- An observed connection, notification or update problem with a relevant corrective
  surface, while its owner still reports the condition as unresolved.

Deduplicate repeated observations and overlapping task indicators by their owning
task/turn, request or blocker identity. Prefer the pending decision as the task's
primary action. Historical failures remain in Events but stop contributing to
attention after the owner confirms recovery or a successful successor. Receipt
stalling alone never proves task failure. Unknown execution and incomplete coverage
retain their existing meaning and do not become invented questions or failures.

There is no mark-all-resolved control. Opening a row does not answer a question,
clear a blocker, advance a source inbox cursor or acknowledge recovery. Successful
actions refresh the owner projection and therefore the attention list and count.

## Board

Read `board` through the existing bulletin owner. The default view shows active
notices and uncleared blockers. An explicit history option exposes retained closed
and withdrawn records. Resource and project filters select the same underlying
records; do not maintain another resource registry.

Each compact row shows the reported intent or blocker summary, owner, affected
resources, current state and last evidenced activity. Show linked tasks and their
known execution states when expanded. A phase is displayed only when the existing
task owner supplies it. Use the existing owner identity projection; unknown
ownership remains unknown.

Keep these states distinguishable:

| Record | Presentation |
| --- | --- |
| Active notice | Current work and advisory resource claims |
| Closed notice | Closure reason and linked terminal evidence when available |
| Withdrawn notice | Withdrawal reason; no current resource claim |
| Active blocker | A resource condition that remains uncleared |
| Stale or uncertain blocker | Still uncleared, with its activity/coverage limitation |
| Cleared blocker | Clearance evidence and suggested next step |

Use `lastActiveAt`, `inactivityAgeSeconds`, `observedAt` and `activityCoverage` from
the owner. Do not add an independent frontend expiry rule. A missing heartbeat,
disconnection or an old observation never proves completion. A stale blocker never
becomes cleared merely because its owner is inactive. Preserve the native rules
for successor links, terminal closure and clock uncertainty.

### Local actions

Support posting, updating and closing a notice, and opening and clearing a blocker,
using the existing authenticated local authority and bulletin operations. Load the
full owner record before editing. Reuse existing revision, receipt, validation and
error behavior; do not create a second mutation protocol or impersonate a source.

Use the shared `Dialog`, native `form`, fields and inputs. Resource selection and
task links use existing registered identities. Keep constraints beside the relevant
field. Preserve entered values on error and focus the first invalid field. A stale
revision prompts a refresh while preserving the draft where practical.

Blocker clearance collects the evidence required by the native operation: evidence
references and a verified commit or explicit non-code recovery reason. Display the
recorded suggested next step after clearance. Clearing a blocker never resumes a
task. Closing a notice does not stop its linked tasks. Show these consequences at
the respective action, where they affect the user's decision.

Display the owner's advisory conflicts next to the affected resources. Conflicts
do not disable an otherwise authorized action. Distinguish partial or unknown
conflict coverage from an empty conflict set.

## Studio integration

Make the existing Studio pending-task summary open Events filtered to pending task
input. Keep its count derived from the existing shared task activity projection.
Do not silently mix blockers and connection problems into that task count. The
workspace capsule can show the broader attention count defined above.

Preserve the clock, date, running-task summary, arc interactions, topology and
background. Keep zero-count summaries hidden. Add no focus timer, scrolling event
wall, extra status cards or persistent board overlay to the homepage.

## Data and ownership

`coordination` owns event history; `coordination::bulletin` owns notices and blockers.
The existing activity, task, connection and update owners supply their current
states. React stores only view state, bounded query results and editable drafts.
Keep source visibility, local authority and resource boundaries in the native layer.

Add thin local management adapters only where desktop access is missing. Route
them through the existing domain operations and register their current contracts.
Do not read or mutate coordination files directly from the frontend. Keep the
control-source `guide`, `query`, `act` schemas and the single `notification` event
with its `{op, args}` envelope unchanged. Additional desktop reads do not introduce
a generic event bus, resource push protocol or background message delivery system.

Reuse existing live snapshots for current task conditions. Do not request a native
timeline, start an Agent or crawl task history for each event row. Load details on
demand. Fetch bounded pages, respect each owner's cursor and filter scope, cancel
obsolete requests, and avoid polling closed or hidden views unnecessarily.

Journal cursors are opaque sequence positions, not timestamps. Preserve high-water
pagination and explicit retention gaps. On cursor expiry or scope change, use the
provided reset contract and disclose the missing interval. A failed refresh keeps
the last readable snapshot with an unavailable/stale state and a retry action.
Board and event failures are independent; one cannot erase the other's valid data.

No new persisted unread store is required for this version. Current actionable
state and retained history provide the two product concepts.

## Layout and accessibility

Use existing semantic tokens, shared controls and Radix foundations. Use a compact
list with an inline detail region on wide panels; use a single content column on
narrow panels. Keep the title and necessary controls visible while the list scrolls.
Long names, summaries and resources must wrap or truncate without losing access to
the full value. Do not depend on helper slogans or secondary labels to explain the
layout.

Support light/dark themes, Chinese/English, portrait/landscape, keyboard navigation,
layered Escape, focus restoration and reduced motion. Expose state and action names
to assistive technology. Background refresh must not steal focus or repeatedly
announce the entire feed. Preserve a stable reading position as new events arrive.

## Acceptance

Browser fixtures cover the complete UI interaction with synthetic metadata and
stateful owner responses. Unsupported fixture mutations fail locally. UI acceptance
uses these fixtures, including states absent from the current fixture catalog.

| Scenario | Observable result |
| --- | --- |
| Several concurrent tasks and resources | Distinct work, changes and blockers are discoverable from the shared entry |
| A pending task question | Studio and workspace counts agree on that task; opening the row selects the correct task/turn |
| Answering through the existing task detail | Owner state refresh removes the pending item and updates the count |
| Repeated failure observations and a successful successor | One current attention item before recovery; history remains after recovery |
| Notice create, update and close | Readback shows the saved record and closure without stopping linked tasks |
| Blocker open and clear | Required evidence is enforced; clearance readback retains evidence without resuming tasks |
| Stale owner, interrupted task and unknown activity coverage | No inferred completion, clearance or fresh heartbeat |
| Cursor gap, unavailable query and empty data | Gap, retryable failure and genuine empty state remain distinct |
| Long content, narrow portrait and both themes | Controls and details remain usable without horizontal page overflow |
| Keyboard and nested detail/dialog navigation | Correct focus, layered Escape and return to the prior workspace context |

Run the repository's normal checks and the affected UI fixture scenarios. Native
management changes additionally require a focused behavior check through their
public operation boundary. Fixture success alone does not cover those native
adapters. Respect the repository's test ownership, policy and normal-suite budget.
Keep screenshots and execution evidence outside the repository.

## Scope boundary

This version includes the workspace, native desktop adapters required by it,
actionable current-state projection, local bulletin actions, Studio entry,
fixtures and current user/maintainer documentation. It does not include a community
workflow engine, MCP service productization, AX triage UI, a private-message center,
generic subscriptions, resource locks, automatic resumption or a new dispatch policy.
