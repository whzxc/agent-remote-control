# Independent window stays usable

Use the [installed runner](../installed.md). Keep an ended task and a turn blocked on the provider gate in the independent window. Record their IDs, titles, window identity and `h instance`. Use another finished task as a read-only witness in main. Do not close the independent window during this case.

| Case | Replay from a fresh seed |
| --- | --- |
| live-boundaries (D2) | Run once with time passing for more than 30 seconds, with graceful ARC quit/reopen, abrupt Core loss (`h core-crash`) and recovery, ordinary Core restart, and a signed ARC update. Repeat each at these boundaries: after the window appears with the first task, during a second accepted turn, and immediately after its terminal event. Keep a mixed running/ended cohort at each boundary. An exit/crash of the independent instance switches to the exit rule. |
| live-overlap (D3) | Query owner concurrently from the control source and task details while a running turn ends. Repeat both reads after a Core restart, then repeat the restart while the same window remains open. Exercise rapid selections of two different task details during the reads. |

- **arc-instance-left-alone / instance-survives** — after each boundary the PID and creation identity from `h instance` equal the original and the original window is still present and responsive. Record window identity before and after. A replacement with the same title fails.
- **arc-instance-left-alone / no-release-while-running** — during and after each boundary the finished threads stay in that window's active list and main cannot take over the same threads or archive them. Observe continuously for unexpected removal or navigation. The gated turn can resume normally without reloading or recovering the task. Use fresh witness threads for attempts that could succeed on a defective build.
- **arc-instance-left-alone / tasks-usable-there** — release the gate. In the original window send a distinct marker to **each** task and read it back from its original thread along with the reply. Record per-thread results and the window identity.
