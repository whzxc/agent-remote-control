# Process exit, remaining clients and handback

Use the [installed runner](../installed.md). Keep a parent task gated on the provider and the MacBook main Desktop on an unrelated thread. Prepare finished parent/child families with ARC as sole holder, and matched families with a surviving client on the same shared daemon. Record the writer and subscription baselines before triggering any exit. Use separate seeds for window-only close and the Reopen action.

| Case | Inputs and boundaries |
| --- | --- |
| exit-states (D1) | Cross completed, failed and interrupted last turns with zero children and with children. Include sole-holder and remaining-holder outcomes, including a child retained independently. For a running parent, release the provider gate once successfully and once with a non-retryable failure. |
| exit-boundaries (D2) | Compare a window-only close with the same process alive, normal process Quit, forced process crash, and old-process exit during a real ChatGPT app update. Trigger each just after dispatch acceptance, while the turn runs, and just after the original terminal event. Separately interrupt ARC via graceful exit/relaunch, Core crash/recovery, Core restart, or signed ARC update before the independent process exit, after exit while the turn is running, on either side of its terminal event, and after the first eligible family releases. Preserve original timing anchors through reconnects. |
| exit-scale (D11) | Use 1, 8 and 32 finished parents plus a gated parent. Alternate families with zero, one and two children and cycle the three terminal states. Keep a witness on selected families. Record both branches per ID, including a held child with a clear parent. Use a cohort with all family locks clear for the parent-archive check. |

- **instance-exit-unlocks-tasks / window-close-not-exit** — close only the window. Verify its process identity with `h instance` throughout an interval longer than 30 seconds. The case retains its hold, ARC shows neither handback nor the exited-instance recovery action, and main cannot take the parent. Show a window in the same resident process and continue each parent there without recreating a thread. If close terminates the process on this installation, record the unmet resident-process precondition.
- **instance-exit-unlocks-tasks / own-hold-dropped** — anchor at the recorded PID exit. Check each finished parent and child by exit + 30 seconds using the shared hold protocol. In the ARC-only family observe actual clearance. In the co-subscribed family the other client's thread remains usable on its own connection; only an attributable release observation can establish the ARC-specific time. Record any attribution gap per thread.
- **instance-exit-unlocks-tasks / handed-back** — for each clear writer, ARC marks that exact task handed back. For a clear family, main accepts a new message on the parent. Archive the parent once and read back the parent and **all** its children in Archived. A visible mark while a known witness still holds the writer fails.
- **instance-exit-unlocks-tasks / holder-shown** — keep the witness subscribed and the lock held, including after the ARC release deadline. ARC reports the remaining holder for that thread and withholds its handed-back mark. For a shared daemon with no identifiable client, naming that server and explicitly reporting the client as unknown is a valid diagnosis. Voluntarily release at the witness, observe actual lock clearance, and check the handed-back mark and parent actions.
- **instance-exit-unlocks-tasks / running-status-shown** — during actual process absence, keep the original turn gated. In its task details inspect the targeted task with forwarded screen/tree with the unique task title. Observe the closed-window/still-running message and enabled Reopen. Recheck after reconnect and after the terminal transition. If Accessibility is unavailable, use the targeted ARC window and record the manual observation.
- **instance-exit-unlocks-tasks / reopen-shows-task** — in a separate gated trial press Reopen once through forwarded screen/press. Identify the independent PID and profile. Its front window shows the same parent, thread ID and turn history. Main stays on its unrelated task. Exit the reopened instance before a subsequent handback trial.
- **instance-exit-unlocks-tasks / running-not-interrupted** — in the untouched trial release the gate after process exit. The original turn ID finishes naturally with the expected reply or provider failure. Check that ARC did not interrupt or replace it.
- **instance-exit-unlocks-tasks / running-handed-back-after** — use the original terminal event as the new 30-second anchor for ARC's own release. Confirm the same clear/handed-back and still-held/holder-shown branches as for finished tasks. In the clear branch continue the parent in main, then archive its whole family from the parent action.

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
