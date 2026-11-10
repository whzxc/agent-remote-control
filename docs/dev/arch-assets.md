# Architecture assets

[Architecture](architecture.md) · [Agent scenarios](agent-scenarios.md) · [Design sources](design.md)

`arch/` holds reviewable diagrams of ARC's runtime structure. They show components,
processes, state machines and cross-process flows at the level a reviewer needs
before reading code. [Architecture](architecture.md) remains the precise contract.

## Layers

- Layer 0, system map: processes, external parties and how they connect.
- Layer 1, components: one diagram per process showing its internal modules. Core is
  drawn. Front door and Desktop are not drawn.
- Layer 2, mechanisms: one diagram per state machine or cross-process flow.
- Agent-facing responses are covered by [Agent scenarios](agent-scenarios.md).

## Format

Each asset is one Mermaid source file (`.mmd`) holding one diagram. Two leading `%%`
comments name the asset and point to this index. Labels use code names. Prose
explanations belong in the review rendering, not in the source.

## Assets

| Asset | Shows | Owning code paths | Status |
| --- | --- | --- | --- |
| [system-map.mmd](../../arch/system-map.mmd) | Control sources, connections, front door, Core, state directory, MCP hub, Codex Desktop, ARC App Server, task-host and native session stores | `native/src/front_door*`, `native/src/service.rs`, `native/src/ingress*`, `native/src/relay/`, `native/src/codex_host.rs`, `native/src/task_host.rs`, `desktop/` | Reviewed |
| [components/core.mmd](../../arch/components/core.mmd) | Core request path, business owners, background work, kernel records and turn classification | `native/src/front_door.rs`, `native/src/core_requests.rs`, `native/src/execution.rs`, `native/src/egress.rs`, `native/src/transport.rs`, `native/src/control.rs`, `native/src/agents/`, `native/src/accounts/`, `native/src/coordination/`, `native/src/dispatch_policy*`, `native/src/mcp_hub.rs`, `native/src/claude_notify*`, `native/src/dispatch_queue.rs`, `native/src/subscriptions/`, `native/src/kernel/` | Reviewed |
| [mechanisms/main-loop.mmd](../../arch/mechanisms/main-loop.mmd) | One Codex dispatch from `codex_create` through observation, push, `codex_read` and `codex_review` | `native/src/core_requests.rs`, `native/src/control.rs`, `native/src/execution.rs`, `native/src/claude_notify*` | Reviewed |
| [mechanisms/receipts.mmd](../../arch/mechanisms/receipts.mmd) | Receipt states and transitions | `native/src/kernel/receipts.rs`, `native/src/kernel/receipts/` | Reviewed |
| [mechanisms/turn-lifecycle.mmd](../../arch/mechanisms/turn-lifecycle.mmd) | `TurnState` classification from owner and native terminal evidence | `native/src/turn_lifecycle.rs` | Reviewed |
| [mechanisms/notification-flow.mmd](../../arch/mechanisms/notification-flow.mmd) | Binding, observation, delivery gates, L1/L2 sends and the ingress inbox | `native/src/claude_notify.rs`, `native/src/claude_notify/observer.rs`, `native/src/claude_notify/scheduler.rs`, `native/src/claude_notify/mcp_events.rs` | Reviewed |
| [mechanisms/notification-delivery.mmd](../../arch/mechanisms/notification-delivery.mmd) | Status of one delivery record | `native/src/claude_notify.rs`, `native/src/claude_notify/governance.rs`, `native/src/claude_notify/scheduler.rs` | Reviewed |
| [mechanisms/notification-reachability.mmd](../../arch/mechanisms/notification-reachability.mmd) | Handshake state of one notification target | `native/src/claude_notify/reachability.rs` | Reviewed |

## Review

A change that alters what an asset shows updates the asset in the same change.
Segment review checks whether a diff touching an asset's owning code paths requires
an asset update. The control source renders changed diagrams before and after.
Changes that only reflect implementation are reviewed by the control source. Changes
that alter behavior go to the user before implementation.

## Limits

- Diagrams omit error paths, limits and timing details that [Architecture](architecture.md) documents.
- No automated check links diagram elements to code. Freshness depends on review.
- The receipt wire format also defines `cancelled` and `rolled-back`.
  `kernel::receipts::progress::advance` does not produce either state, so the
  receipt diagram omits them.
