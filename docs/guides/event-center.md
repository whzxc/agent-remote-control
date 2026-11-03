# Find changes and coordinate shared work

Open **Event center** in the bottom-left navigation capsule.
Choose **Events** to inspect changes or **Board** to coordinate resources.
Use **Needs attention** to find current actions. Use the resource filter to narrow
both views. Studio's pending-task count opens **Task input** directly.

## Handle an event

Open a task to answer its question, respond to a permission request, or use its
existing retry or resume controls. Closing the detail returns to the event center
with its filters preserved. Connection and update links open their existing
controls. Expand grouped observations to inspect individual outcomes and IDs.

The capsule counts distinct current actions, including outstanding blockers and
observed connection, notification and update problems. Studio keeps its task-only
count. An unavailable total appears as a dash. Opening a record leaves its action
outstanding until its owner confirms a change.

Use **Load retained history** to read older journal pages. If retention or a scope
change invalidates a cursor, inspect the gap and choose **Reset cursor**. A failed
refresh keeps the last readable data and offers a retry.

## Publish work and resource conditions

In **Board**, choose **Post notice**. Enter a one-line intent, select resources,
and estimate the duration in seconds. Link local tasks when available. Open a
notice to edit it or close its work scope. Closing a notice releases its advisory
claims and leaves linked tasks running.

Choose **Open blocker** to report a resource condition. Supply its cause code and
summary. A stale or uncertain blocker stays outstanding. Open it and choose
**Clear blocker** after recovery. Supply evidence IDs and either a verified Git
commit in a registered project or an explicit non-code recovery reason. Select a
suggested next step. Clearing the blocker leaves task continuation to the user or
its owning source.

Use **History** to include closed, withdrawn and cleared records. Details retain
the reason, evidence, owner and last evidenced activity. Resource conflicts are
advisory; incomplete conflict coverage remains visible.

## Limits

The journal retains bounded instance-local metadata. Current task attention uses
already observed activity and execution results. Unknown or unavailable observation
can leave coverage incomplete. A missing heartbeat does not confirm completion.

Project choices come from ARC's cached registered-project projection. Refresh
projects through their owner when a repository is missing. Existing record resources
remain selectable. Task links retain the native dispatch-origin restriction.
Source-owned links can be preserved during local editing; adding links still
requires an evidenced local dispatch. Metadata references without an available
local target remain readable by ID.

Notification problems link to the existing connection surface. Source-specific
reachability and delivery diagnosis remain available through `notify_status`.
The event center introduces no notification acknowledgement or recovery form.
