---
owners:
  - native/src/claude_notify.rs
  - native/src/claude_notify/observer.rs
  - native/src/claude_notify/scheduler.rs
  - native/src/claude_notify/mcp_events.rs
status: Reviewed
---
Known gap on Observer: merging observations orders them by arrival instead of by evidence time, so a stale read can overwrite newer state. The notification delivery diagram shows the effect.

Native progress uses the latest response item, streaming delta or changed token counters. A running turn becomes stalled after three minutes without activity, from startup or mid-turn. In-progress tools and command executions suspend this diagnostic. Tool completion restarts the inactivity interval. Unchanged token counts provide supporting evidence.
