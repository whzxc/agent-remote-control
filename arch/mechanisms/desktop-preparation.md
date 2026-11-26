---
owners:
  - internal/core/desktop_recovery*.go
  - internal/core/desktop_daemon_darwin.go
  - internal/core/desktop_handback*.go
  - internal/core/control.go
  - ui/components/DesktopRecoveryNotice.tsx
status: Approved
---
Desktop preparation precedes all native writes for a new macOS Desktop dispatch. A local restart decision applies to one process creation identity. An independent launch preserves the current Desktop and shares the native Codex home. Recovery results are published on the original receipt.

After a recorded process exit, Core releases its subscriptions to eligible members of the task subtree. Writer-lock observations determine handback. Active tasks can reopen in the independent profile.
