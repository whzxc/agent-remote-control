# Startup reconciliation of pre-update tasks

Use the [installed runner](../installed.md) on the previous ARC release. Dispatch the tasks there, finish the seeds and record the original IDs. In one cohort only ARC has a subscription. In the other, `h subscribe "$thread"` adds an independent client before the old instance process exits. Keep the witness connected, the native daemon running, and both case data roots intact throughout the update.

| Case | Starting population |
| --- | --- |
| upgrade-existing (D7) | Run with a sole-held family and again with a co-subscribed family. On the old build confirm the process has exited, main cannot continue the parent, and the native writer remains held. Record every parent and child separately. |
| upgrade-scale (D11) | Repeat with 1, 8 and 32 pre-existing parents. Mix completed, failed and interrupted turns, families with and without children, and both holder outcomes. Keep one co-subscribed child to check that ARC reports each item's own result. |

Pre-stage the signed ARC successor before exiting the old independent process. Install and start it. Verify the new build and same state, home and daemon identity. Keep task details closed during startup and allow recovery without issuing an owner, resume, release, open or archive request. Observe the independent native writer and any available passive trace from outside ARC. Read the displayed results only after this observation interval.

- **earlier-held-tasks-unlock / own-hold-dropped-at-start** — on startup ARC relinquishes its own holds for the original IDs without a user action. Record per-thread native release evidence and subsequent main usability for a clear writer. When the witness keeps the same writer held, collect the connection-attributed release evidence described in the shared protocol, or mark ARC-specific release unmeasured. Record elapsed time; the startup rule specifies no deadline.
- **earlier-held-tasks-unlock / handed-back-or-holder** — compare each mark with its independently observed writer. Main can continue a handed-back parent and archive its whole clear family via the parent action. A still-held task names its remaining holder and stays out of the handed-back state. The witness remains subscribed until its own operator releases it. After actual clearance check the new handback mark.
