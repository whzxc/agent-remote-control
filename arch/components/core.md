---
owners:
  - internal/core/front_door*.go
  - internal/core/core_requests.go
  - internal/core/execution.go
  - internal/core/egress.go
  - internal/core/transport.go
  - internal/core/control.go
  - internal/core/agents*.go
  - internal/core/accounts*.go
  - internal/core/coordination*.go
  - internal/core/dispatch_policy*.go
  - internal/core/mcp_hub*.go
  - internal/core/claude_notify*.go
  - internal/core/dispatch_queue.go
  - internal/core/subscriptions*.go
  - internal/core/kernel*.go
  - internal/core/turn_lifecycle.go
status: Approved
---
mcp_hub is experimental, as on the system map. turn_lifecycle is pure classification shared by background work.
accounts owns control-source identities, platforms, SRC containers and Claude CLI profiles for L1 notification push only; multi-account Agent dispatch and secondary Codex credentials are removed.
dispatch_policy provides task-level criteria, defaults/constraints, packs and review/quality history without an advisory account load-balancing engine.
subscriptions and Control optionally read a local Magpie-compatible gateway for pool quota aggregation and per-turn token/cost/served-route backfill, falling back to native reads when absent.
