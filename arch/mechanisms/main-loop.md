---
owners:
  - native/src/core_requests.rs
  - native/src/control.rs
  - native/src/desktop/daemon.rs
  - native/src/desktop/recovery.rs
  - native/src/execution.rs
  - native/src/claude_notify*
status: Reviewed
---
One Codex dispatch from codex_create to codex_review. Push delivery details are in the notification flow and delivery diagrams.

On macOS, Desktop dispatch can prepare its execution route before creating a thread. The original receipt remains pending when ARC needs a local choice. Concurrent requests share a preparation gate. Only the selected Desktop process is eligible for a graceful quit, and a ready route is reused. Cancellation ends the original request before native submission.
