# Active foreign session

Use the [installed runner](../installed.md). Dispatch through ARC first. Once the independent instance is gone and the task is free, acquire that **same** thread with a Codex terminal client from the guest. Also run with an SSH login from another disposable machine into the guest account. Explicitly select the guest's case Codex home in that SSH session. Record the known writer PID, executable, terminal device and client origin from the holder side. Confirm the terminal can send to the exact task. Keep its writer alive. Close any guest GUI window that could be mistaken for the owning app.

| Case | Source states |
| --- | --- |
| foreign-states (D1) | For local and SSH holders, query during an active turn and with a completed, failed or interrupted last turn. Repeat with no subagents and with a real subagent, querying the held parent and, in a separate trial, the held child. Exercise control-source owner reads and opening the ARC task details. |

- **foreign-holder-reported / holder-named** — `h ctl codex_owner '{"threadId":"…"}'` identifies the actual holding process and where it came from. Compare reported origin with the known local terminal or SSH session, including the reported peer when present. A bundled executable or an unspecified external writer alone does not identify the source.
- **foreign-holder-reported / holder-untouched** — after each owner read the same PID/start identity remains alive and the same terminal can send and read back a distinct marker on that task. Check before following instructions that deliberately end the session.
- **foreign-holder-reported / steps-workable** — enumerate every instruction and structured next action offered. Perform each alternative from a fresh equivalent seed. Execute readbacks with the supplied operation and exact args. For manual actions, reach the named terminal/window, take the action, and confirm the advertised effect on the same thread. Record an unreachable GUI, circular recovery with no actionable handoff, or instructions for a different task as a failure.
