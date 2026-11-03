# Read the Agent Board

Click the current-activity row below the homepage clock and date to open **Board**.
The whole row opens the dialog. With Studio disabled, the activity row remains at
the top of the homepage. Its running and pending-input counts keep their task-only
meaning.

## Inspect current work

**Current** shows running work, published resource declarations, resource blockers
and outstanding items. Filter by resource or choose **Task input** to find tasks
waiting for a user decision. Open a record to inspect its owner, resources, state
and last observed activity. Use **History** to include closed, withdrawn and
cleared records. Expand **Metadata** for record identifiers and raw evidence.

**Needs attention** also lists AX candidates waiting for the source that reported
them. Agents see the same matters in `board` and act through each owner's operation.

Board is read-only. Agents publish, update and close their notices through their
existing operations. Resources remain advisory declarations. Outstanding items
stay with their task, resource or service owner until that owner confirms a change.

Follow a task link to answer a question, respond to a permission request or use the
task's existing controls. Connection and update links open their existing surfaces.
Closing the owner detail returns to Board with its view and focus preserved.
Press Escape to leave a record detail, then press Escape again to close Board and
return focus to the homepage activity row.

## Read recent changes

Choose **Activity** for recent journal observations. Expand groups for individual
outcomes. Task links preserve the observed turn, including historical failures.
Use **Load retained history** for older observations. If retention invalidates a
cursor, inspect the gap and choose **Reset cursor**. A failed refresh keeps the last
readable data and offers a retry.

## Limits

The journal retains bounded instance-local metadata. Current task attention uses
already observed activity and execution results. Partial or unavailable observation
remains explicit. A missing heartbeat does not confirm completion or clear a blocker.

Resource choices use cached registered projects and existing records. Refresh
projects through their owner when a repository is missing. Metadata references
without an available local target remain readable by ID.

Notification problems link to the existing connection surface. Source-specific
reachability and delivery diagnosis remain available through `notify_status`.
