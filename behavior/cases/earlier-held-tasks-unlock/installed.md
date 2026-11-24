# Upgrade existing held tasks

Use the [installed runner](../installed.md) on the previous released build. Keep both the isolated Codex home and ARC state on the guest disk and preserve the **running** native daemon across installation. Begin each destructive probe with independent data.

| Case | Starting population |
| --- | --- |
| upgrade-existing (D7) | On the old binary dispatch one task, finish it in the independent instance, then quit that instance. Confirm that main can read its title/history but an actual continuation and an archive attempt are rejected. Record the old build ID, thread/turn IDs and daemon PID. |
| upgrade-scale (D11) | Repeat with 1, 8 and 32 existing parent tasks. Mix completed, failed and interrupted turns and include children in the larger populations. Confirm every subject is locked before the update. Record each ID even if it is outside the first page of tasks. |

1. Prepare the signed update on the old build before closing the independent window. A precondition that cannot reproduce the old lock is an invalid trial.
2. Install the successor and start ARC. Preserve the same main window, native daemon and both data roots. Leave ARC task details closed. Perform no owner query, dispatch, reopen, release, archive-through-ARC or migration command. Allow startup recovery to run autonomously.
3. **earlier-held-tasks-unlock / unlocked-without-action** — for every original ID, main accepts a uniquely marked new turn in the send trial and archives it in the archive trial. Read back the accepted turn and Archived membership as in the shared protocol. Record elapsed time from candidate startup. The approved migration rule gives no time limit. If a bounded runner window expires, retain the observed duration and report pending instead of applying the exit rule's deadline.
