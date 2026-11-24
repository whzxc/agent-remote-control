# Preserve work across ARC replacement

Use the [MacBook setup](../installed.md). Through the same dispatching source establish an active task_status notification listener and record deliveries through a bounded follow-up interval. Dispatch one turn that waits on a case-project gate file before returning a unique marker. Dispatch a second task that genuinely requests approval or user input. Record both thread and turn IDs, private writer PID/start, gate execution identity, and pending request payload. Keep the gate closed and request unanswered through the chosen transition. Reconnect the source on recovery before releasing the gate.

| Case | Matrix |
| --- | --- |
| interrupt-active | D2. Graceful and abrupt Core restart after gate entry, after request appears and immediately before answering. Repeat with the independent window alive and with its process exited while work is pending. |
| recover-records | D7. Recover persisted private task associations on Core restart; repeat across two signed versions supporting the private route. Exercise both approval and input. |
| installed-cutover | D10. Perform a version-changing installed ARC update with both subjects pending and observe the LaunchAgent's replacement process, prior and new build, state and same backend identity. Use a source build capable of creating the required private tasks. |

**turn-continues** — Read the same backend PID/start and original turn active after recovery. Release the original gate once. Observe its unique result and natural terminal state on that turn; inspect history and gate execution ledger for duplicate execution.

**request-answerable** — The original pending question or command remains visible. Answer it through the recovered surface. Verify the answer's unique value in the task's output or the approved command's unique side effect, followed by resolution of that request on the original turn.

**follow-ups-work** — Count delivered completion notifications for the original gate turn from subscription through completion of one further turn. Require exactly one. Send a distinct follow-up on each original task after recovery and verify its accepted marker and reply there. An inbox snapshot alone leaves delivery multiplicity unknown.

Baseline expectation: baseline dispatch cannot seed private-backend work. A shared-backend restart is a setup gap for these verdicts.
