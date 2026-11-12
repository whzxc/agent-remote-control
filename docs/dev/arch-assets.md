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
comments name the asset and point to this index. Labels use code names.

Semantics use Mermaid `class` statements from the ADG vocabulary
([architecture sources](https://github.com/whzxc/agent-design-gallery/blob/main/docs/design-toolkit.md#architecture-sources)).
A phase sets the fill: `progress`, `waiting`, `done`, `stopped` or `uncertain`. A mark
sets the border: `experimental`, `temporary` or `gap`. Sources do not paint; ADG
supplies colors from `design/tokens.css` in both themes.

Each asset has a sidecar beside it with the same name and `.md`. Its frontmatter lists
the owning code paths as `owners` and the review `status`. Its body is a short English
note that explains the phases and marks. ADG shows the note, owners and status in the
Inspector.

## Assets

| Asset | Shows |
| --- | --- |
| [system-map.mmd](../../arch/system-map.mmd) | Control sources, connections, front door, Core, state directory, MCP hub, Codex Desktop, ARC App Server, task-host, native session stores and proposed Device link members |
| [components/core.mmd](../../arch/components/core.mmd) | Core request path, business owners, background work, kernel records and turn classification |
| [mechanisms/main-loop.mmd](../../arch/mechanisms/main-loop.mmd) | One Codex dispatch from `codex_create` through observation, push, `codex_read` and `codex_review` |
| [mechanisms/receipts.mmd](../../arch/mechanisms/receipts.mmd) | Receipt states and transitions |
| [mechanisms/turn-lifecycle.mmd](../../arch/mechanisms/turn-lifecycle.mmd) | `TurnState` classification from owner and native terminal evidence |
| [mechanisms/notification-flow.mmd](../../arch/mechanisms/notification-flow.mmd) | Binding, observation, delivery gates, L1/L2 sends and the ingress inbox |
| [mechanisms/notification-delivery.mmd](../../arch/mechanisms/notification-delivery.mmd) | Status of one delivery record |
| [mechanisms/notification-reachability.mmd](../../arch/mechanisms/notification-reachability.mmd) | Handshake state of one notification target |
| [mechanisms/homepage-modes.mmd](../../arch/mechanisms/homepage-modes.mmd) | Proposed persisted manual modes, static layout inputs, node task-state navigation, execution origin chains and offline task presentation |
| [mechanisms/device-link.mmd](../../arch/mechanisms/device-link.mmd) | Proposed cycle-safe pairing, reachability and one-hop nested homepage device tiers |
| [mechanisms/device-forward.mmd](../../arch/mechanisms/device-forward.mmd) | Proposed (device, agent) dispatch, frozen MCP structures and controller task visibility |

| [mechanisms/device-transfer.mmd](../../arch/mechanisms/device-transfer.mmd) | Device file streaming, verified offsets, receipts and atomic publication |

## Review

A change that alters what an asset shows updates the asset before implementation.
Segment review checks whether a diff touching a sidecar's `owners` requires an asset
update. `adg check` validates classes, sidecars and owner paths. The control source
reviews a proposed diagram against its base with ADG's review overlay (`--base=<rev>`),
which marks added, changed and removed nodes and edges. Updates that only reflect
implementation are approved by the control source. Behavior changes need user approval
of the updated asset first.

## Limits

- Diagrams omit error paths, limits and timing details that [Architecture](architecture.md) documents.
- `adg check` confirms that owner paths exist. It does not link diagram elements to
  code, so freshness depends on review.
