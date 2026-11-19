---
owners:
  - native/src/front_door.rs
  - native/src/core_requests.rs
  - native/src/execution.rs
  - native/src/egress.rs
  - native/src/transport.rs
  - native/src/control.rs
  - native/src/agents/**
  - native/src/accounts/**
  - native/src/coordination/**
  - native/src/dispatch_policy*
  - native/src/mcp_hub.rs
  - native/src/claude_notify*
  - native/src/dispatch_queue.rs
  - native/src/subscriptions/**
  - native/src/kernel/**
  - native/src/turn_lifecycle.rs
status: Approved
---
mcp_hub is experimental, as on the system map. turn_lifecycle is pure classification shared by background work.
accounts owns control-source identities, platforms, SRC containers and Claude CLI profiles for L1 notification push only; multi-account Agent dispatch and secondary Codex credentials are removed.
dispatch_policy provides task-level criteria, defaults/constraints, packs and review/quality history without an advisory account load-balancing engine.
subscriptions and Control optionally read a local Magpie-compatible gateway for pool quota aggregation and per-turn token/cost/served-route backfill, falling back to native reads when absent.
