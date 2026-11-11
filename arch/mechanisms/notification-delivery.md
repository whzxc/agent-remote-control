---
owners:
  - native/src/claude_notify.rs
  - native/src/claude_notify/governance.rs
  - native/src/claude_notify/scheduler.rs
status: Reviewed
---
inbox-only counts as done: the event stays in the ingress inbox without a push. Known gap on resolved: a stale running read can mark a pending needs-input delivery resolved, so that reminder is never pushed.
