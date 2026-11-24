# Exit with terminal and running tasks

Use the [installed runner and deadline protocol](../installed.md). Keep the main Desktop on its separate app-server, ARC open on the gated task's details, and the native daemon alive throughout. Prepare an unrelated open thread in main to distinguish the target of Reopen.

| Case | Inputs and boundaries |
| --- | --- |
| exit-states (D1) | Cross completed, failed and interrupted **last turns** with zero children and with children. Record the parent and every child independently. Include an additional running turn which finishes naturally, once successfully and once with a genuine provider failure. Run separate untouched and Reopen trials. |
| exit-boundaries (D2) | Repeat normal Quit, last-window close with process exit, forced crash and external normal termination of the same PID. Apply each exit just after dispatch acceptance, during an active turn, and just after its terminal event. For external termination, use `h terminate`. Repeat with Core restart, Core crash/recovery, graceful ARC quit/reopen and a ready signed update immediately before exit, after exit while the turn is running, and on each side of its terminal event. Also interrupt recovery after one of several eligible tasks becomes writable and before the others are confirmed. Keep the original exit and terminal deadlines for each member. |
| exit-scale (D11) | Run with 1, 8 and 32 ended parent tasks, plus one gated task. In mixed cohorts give alternate parents one or two children and cycle through all three terminal states. Give each a distinct title and check every ID, including every child. |

- **instance-exit-unlocks-tasks / finished-continuable** — in the send trial every already-finished parent and child accepts its unique message from main by exit + 30 seconds. Verify each marker in that same thread.
- **instance-exit-unlocks-tasks / finished-archivable** — in the independent archive trial every already-finished parent and child can be archived from main by exit + 30 seconds. Check each ID in Archived after refresh. Archive children first on one run to exclude disappearance through parent archival.
- **instance-exit-unlocks-tasks / running-status-shown** — while the provider gate remains closed, revisit the exact active turn's ARC details. In the English guest, run `h status-shown "HB running"` with its actual unique title. They say the window has closed and the task is still running, and expose an enabled Reopen action. Verify again after a Core reconnect. If the guest has no Accessibility permission, inspect the selected task and press the action directly, recording that the AX check was unavailable. Check the status while the task is active and its removal after the terminal outcome. Generic Running and generic Open alone fail.
- **instance-exit-unlocks-tasks / reopen-shows-task** — in the separate Reopen trial, activate that action once with `h reopen "HB running"` (or press the button in the targeted ARC window). Identify the new independent PID and profile with `h instance`. Its front window shows the original title, thread ID and existing turn history. Main stays on its unrelated thread. Exit the reopened instance before testing handback again.
- **instance-exit-unlocks-tasks / running-not-interrupted** — in the untouched trial keep the instance closed, release the provider gate, and verify the **original** turn ID finishes with the expected reply or provider failure. An interruption, replacement turn or manual Resume fails.
- **instance-exit-unlocks-tasks / running-unlocks-after** — run the send and archive probes on that formerly running task from main, using the original turn's terminal event + 30 seconds. Verify actual history and archive membership independently.

## Replay the task details without a Desktop

During the closed-window, active-turn interval, capture the selected task through the installed management API. Use a neutral prompt and title containing none of the status or button text. Keep the input with the run evidence.

```sh
h capture-detail "$thread" > "$run/closed-active.json"
```

On the matching source revision, run the renderer test with the captured JSON. It mounts the task detail, checks the message and enabled action, and never opens a Desktop. The installed Reopen trial verifies the resulting window and conversation.

```sh
npm run check:tests && HANDBACK_DETAIL="$run/closed-active.json" node --test behavior/cases/instance-exit-unlocks-tasks/detail.test.mjs
```

For the old renderer only, `HANDBACK_DETAIL=baseline` selects a synthetic active turn with a Desktop-held writer. The legacy public timeline has no independent-window-exit observation. This mode demonstrates the old rendering; use a fresh captured projection to judge a candidate.
