# Foreign holder and its subscriptions

Use the [installed runner](../installed.md). Record the native writer PID/start identity, actual terminal/peer when identifiable, and original thread and parent IDs. Close any unrelated GUI window that could be mistaken for the holder. Use three setups:

1. A known local terminal takes a handed-back parent in the case home and continues it. Record the terminal device and process on the holder side.
2. A Codex client enters from a Mac mini through SSH into the MacBook account with the case home explicitly selected. The remote operator controls its session.
3. Before the independent instance exits, run `h subscribe "$thread"` from a second case shell. This client shares the daemon, so its PID need not appear on the lock descriptor. Run with two independent clients as well, and keep the second connected when the first voluntarily releases. Give each witness an unrelated control subscription in a separate connection.

| Case | Source states |
| --- | --- |
| foreign-states (D1) | Query with a running, completed, failed or interrupted last turn. Repeat for a parent with zero and with real subagent children. Query each held child too. Exercise the control source and ARC details. For active subscribed tasks release the existing provider gate and observe delivery of the original terminal event on the witness connection. |

- **foreign-holder-reported / holder-named** — `h ctl codex_owner '{"threadId":"…"}'` and the holder display name the actual holder and its origin when available. For the shared-daemon setup, naming the shared app-server and explicitly saying the client is unknown also passes. Check against the MacBook's known process and topology. An unsupported attribution to a specific app, window, or SSH client fails.
- **foreign-holder-reported / holder-untouched** — after reads the original process/session remains usable. Each witness receives the original thread's subsequent event when one is available, without resubscribing. When the operator finally releases from that same connection, it must still have its original subscription to release. Repeat through Core restart, checking both the target and unrelated control. The remote session remains under the remote side's control. Use parent sends only; check child subscriptions through notification delivery and the client's native unsubscribe result.
- **foreign-holder-reported / steps-workable** — enumerate each suggested instruction and structured action and exercise each alternative from a fresh equivalent state. Verify the exact target and result. A remote action is taken on the remote side, by that operator. If the client is unknown, verify that any suggested diagnostic or local readback actually works with the available evidence. Advice directing the user to an absent GUI, assuming an unknown client's identity, or instructing this ARC to terminate the foreign process or unsubscribe its clients fails.
