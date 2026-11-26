---
owners:
  - internal/core/core_requests.go
  - internal/core/control.go
  - internal/core/desktop_daemon_darwin.go
  - internal/core/desktop_recovery*.go
  - internal/core/execution.go
  - internal/core/claude_notify*.go
status: Reviewed
---
One Codex dispatch from codex_create to codex_review. Push delivery details are in the notification flow and delivery diagrams.

On macOS, Desktop dispatch can prepare its execution route before creating a thread. The original receipt remains pending when ARC needs a local choice. Concurrent requests share a preparation gate. Only the selected Desktop process is eligible for a graceful quit, and a ready route is reused. Cancellation ends the original request before native submission.
