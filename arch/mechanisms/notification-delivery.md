---
owners:
  - internal/core/claude_notify.go
  - internal/core/claude_notify_governance.go
  - internal/core/claude_notify_scheduler.go
status: Reviewed
---
inbox-only counts as done: the event stays in the ingress inbox without a push. Known gap on resolved: a stale running read can mark a pending needs-input delivery resolved, so that reminder is never pushed.
