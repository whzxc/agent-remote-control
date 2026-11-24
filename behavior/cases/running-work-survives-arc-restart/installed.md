# Preserve work across ARC replacement

Use the [MacBook setup](../installed.md). Through the same dispatching source establish an active task_status notification listener and record deliveries through a bounded follow-up interval. Dispatch one turn that waits on a case-project gate file before returning a unique marker. Dispatch a second task that genuinely requests approval or user input. Record both thread and turn IDs, private writer PID/start, gate execution identity, and pending request payload. Keep the gate closed and request unanswered through the chosen transition. Reconnect the source on recovery before releasing the gate.

| Case | Matrix |
| --- | --- |
| interrupt-active | D2. Graceful and abrupt Core restart after gate entry, after request appears and immediately before answering. Repeat with the independent window alive and with its process exited while work is pending. |
| recover-records | D7. Recover persisted private task associations on Core restart; repeat across two signed versions supporting the private route. Exercise both approval and input. |
| installed-cutover | D10. Perform a version-changing installed ARC update with both subjects pending and observe the LaunchAgent's replacement process, prior and new build, state and same backend identity. Use a source build capable of creating the required private tasks. |

**turn-continues** — Read the same backend PID/start and original turn active after recovery. Release the original gate once. Observe its unique result and natural terminal state on that turn; inspect history and gate execution ledger for duplicate execution.

**request-answerable** — The original pending question or command remains visible. Answer it through the recovered surface. Verify the answer's unique value in the task's output or the approved command's unique side effect, followed by resolution of that request on the original turn.

**follow-ups-work** — Before releasing the original gated turn, attach a receiving destination for this source that logs each raw delivery's event ID, thread ID, turn ID, kind and acknowledgement. Keep the recipient ledger alive independently of ARC and disable recipient-side deduplication for observation. Read the source inbox and filtered notify_status for the matching completion before a task read can acknowledge it. A normal webhook acknowledgement is HTTP 2xx. Record the webhook-id header and body eventId on each attempt. Count logical completion records and raw arrivals separately. On each trial send a unique follow-up after restart and confirm its accepted marker and reply on the original thread.

| Case | Delivery boundary | Passing evidence for follow-ups-work on this trial |
| --- | --- | --- |
| normal-first-ack | After ARC recovers, let the original turn finish. The healthy receiver returns success on its first delivery. | One recorded completion for this thread and turn, one matching arrival and successful first acknowledgement. Keep the ledger through the next eligible retry interval and follow-up completion. |
| retry-completion | Receive and record the first attempt, then withhold its acknowledgement or return a retryable failure. Acknowledge the retried delivery. Repeat with ARC interrupted between receipt and acknowledgement, retaining the receiver ledger and recovering ARC before acknowledging a retry. | One recorded completion. All attempts for this completion carry its original event ID, including the observed retry. Verify eventual delivery and a successful follow-up. An unexercised retry window is a gap for that boundary. |

Baseline expectation: baseline dispatch cannot seed private-backend work. A shared-backend restart is a setup gap for these verdicts.
