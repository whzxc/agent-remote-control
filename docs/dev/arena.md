# Arena homepage

> Status: target. The topology rewrite implements this page, then deletes this line and the superseded homepage sections in `ui.md`, `task-tracking.md`, `accounts.md` and `portrait-layout.md`.

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

The homepage shows loops: who dispatched work to whom, through ARC, right now. It is read-only. Roles come from each dispatch, not from a fixed SRC or AGENT side.

## Areas

- **Candidates** sit at the top. Cloud accounts are on the left; local accounts are on the right. A candidate is an account: a remote control-source account or a local Agent account. Within each side, candidates keep the existing persisted source and Agent order. Agent candidates keep their quota rings.
- **Stage** fills the rest. The ARC ring stays at the center of the first hop.
- A candidate whose conversations are on stage shows a dot in its loop color. A candidate with unread completed work keeps its unread mark after its nodes leave the stage.

## Stage nodes

A stage node is a conversation, spawned from its account candidate.

| Node | Source of truth | Shows |
| --- | --- | --- |
| Executor | An activity session that has a `dispatchSummary` | The existing task bubble: phase tile, title, headline, model pill and duration. |
| Agent dispatcher | `dispatchSummary.caller` `{agent, conversationId}` | Conversation title and its Agent account. If that conversation is itself an executor, it is that executor's bubble. |
| Remote dispatcher | `dispatchSummary.controlSource` of a remote source | The source account label. Core does not know the remote conversation. |
| Unattributed dispatcher | A local `controlSource` with no `caller` | One node labelled with the control-source label, spawned from the ring. |

- Sessions without `dispatchSummary` (work typed directly into an Agent) are not loops. They float under their account candidate as small bubbles with a gentle bob and no wire.
- One conversation is one node, even when it dispatches several tasks or appears in several chains.

## Loops

- A loop is a connected group of dispatch edges. Its root is a dispatcher that no other node dispatched.
- The flow runs root → executor → further executors without a depth limit. Landscape flows left to right; portrait flows top to bottom.
- The root column is before the ring and depth 1 after it. Every root-to-depth-1 wire passes through the ring. Later hops connect node to node.
- Each loop occupies its own band across the flow. A node's cross position is centered on its siblings in that loop. Bands stack around the ring's center.
- Each loop gets one color from the chart palette, kept while the loop lives. Every wire of the loop uses it, with a light that flows from dispatcher to executor along the whole chain while work runs. Grouping is never color alone: bands and the continuous wire carry it too.
- An executor waiting for input or approval reverses its light in the warning color toward its dispatcher.
- Too many nodes compress spacing and node width first, then the stage scrolls along the flow: horizontally in landscape, vertically in portrait. Candidates never scroll away.

## Lifecycle

1. **Dispatch.** The dispatcher and executor step down from their candidates on springs. The wire draws in from the dispatcher.
2. **Running.** The light flows. Bubbles update in place.
3. **Ended.** The executor shows its result. The loop stays on stage, dimmed, for a linger period of three minutes after its last activity. A new dispatch in the loop restarts the period.
4. **Read.** Marking any ended node in the loop read, or the period expiring, returns every node of the loop to its candidate on springs. Unread state stays on the candidate until read.

Details open in the existing task detail panel: executor bubbles open that task; Agent dispatcher nodes open their conversation; other nodes do nothing. Candidates open their existing account panels until those panels are removed.

## Ring

The ring keeps the ARC mark and its entry dots. Its radius grows slightly with the number of loops and never overlaps the first two columns. With no loops on stage it shows the current time.

## Motion

- All positions, sizes and opacity use the existing stable-key spring animator, one SVG for wires and same-frame ref transforms. No per-frame React renders. rAF stops at rest.
- Layout is a pure function from activity sessions, accounts and viewport to node and wire targets in `ui/topology`.
- Reduced motion applies targets directly and stops the light.
- Orientation follows the existing Auto/Landscape/Portrait thresholds.

## Removed

Homepage drag reordering, Tree/Flat modes, collapse toggles, path highlighting, outer arcs and earcup tentacles, collapsed five-slot queues, and the topology parameter and debug preferences are removed with the rewrite. The CLI/AX snapshot reports the arena model instead.
