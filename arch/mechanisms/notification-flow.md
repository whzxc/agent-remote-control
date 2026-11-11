---
owners:
  - native/src/claude_notify.rs
  - native/src/claude_notify/observer.rs
  - native/src/claude_notify/scheduler.rs
  - native/src/claude_notify/mcp_events.rs
status: Reviewed
---
Known gap on Observer: merging observations orders them by arrival instead of by evidence time, so a stale read can overwrite newer state. The notification delivery diagram shows the effect.
