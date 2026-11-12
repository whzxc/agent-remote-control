---
owners:
  - ui/App.tsx
  - ui/topology/**
  - ui/components/ConnectionOverview.tsx
  - ui/components/ActivityBubbles.tsx
status: Proposed
---
The homepage has a manually selected, persisted Topology or Tasks mode. The shared
SingleChoice sits below the centered Board header in both modes and all widths. Task
observations never change the selected mode. The selector's Tasks option carries
the needs-me count while Topology is selected. This is ordinary navigation, without an
Experimental toggle or a new bottom-navigation workspace.

Topology positions depend only on configuration, viewport and explicit structural
disclosure. Task observations update task pills without entering layout inputs. No task
children, queues, secondary task tentacles/outer arcs or task focus overlays remain.
A node task pill is a separate task-state action from its management action. Activating it
is an explicit user navigation: persist Tasks mode, scope the list to the node,
scroll to its first matching task and transfer keyboard focus. The highlighted node
chip clears that transient scope. Manual Tasks selection opens all tasks. Mode
choice persists across restarts; jump scope does not. Returning to Topology restores
its configuration-based arrangement.

Tasks cards keep their source, optional remote device, Agent and account as a
compact icon chain. Each icon exposes its identity by accessible name and tooltip.
Controller-dispatched remote tasks show the controller device followed by its member.
On that member, the controller device is the source and there is no extra local-device
step. The controller projection contains only tasks it dispatched to that member.

Groups are Needs me, Running, Completed unread, then Unconfirmed. Recent completed
starts collapsed. Offline members' task observations are unconfirmed, with last-seen
metadata and no live verbs or counts. They do not contribute live attention counts.
Task detail and the existing separate check action for marking read remain distinct.
Within Needs me and Running, Move up/down and the existing ArrowUp/Down card shortcuts
change presentation order only; they cannot cross a group or reschedule task execution.
Unread and Unconfirmed retain observation order. Lists scroll vertically without
queue compaction. Long text truncates with the full accessible title retained.
Portrait and mobile use one column and preserve the header and mode control.

All nodes use the neutral architecture vocabulary. The sidecar's Proposed status
covers the presentation and navigation model; it does not add an experimental flag.

Node task pills are fixed absolute overlays (140×24px full, 104×24px compact), with
semantic outlines and no Agent avatar. Attention, running, current-step icons and an
unread marker share one capsule. Omitted observed phase icons use +N. Counts cap at
99+ or 9+; exact values remain accessible. Offline shows unconfirmed without counts
or live icons. Anchors use fixed label/graphic clearance bands without moving nodes.
The account-group capsule retains its distinct 40px avatar-and-quota form.

The task capsule fits its content inside its fixed overlay envelope; status changes
resize only the capsule paint and never move nodes, labels or configuration wires.

Tasks uses full-width responsive columns: up to three on wide landscape, two on
standard landscape, one on portrait/mobile. Cards expose the current activity, a
bounded native timeline tail (five/three rows), known plan-item counts, elapsed time,
recorded artifact/command/diff summaries and remote path facts. Compact cards expand
in place to four timeline rows. Answer/approval entries, detail and mark-read stay
separate. Partial coverage is visible. No new canonical field, ETA or inferred provider
progress is assumed; the joined card summary remains a new derived UI projection.
The field-to-source mapping is in docs/dev/design.md.

Nested Agent pills also use the 104px compact envelope on landscape. Its right-edge
anchor keeps the maximum capsule clear of the neighboring local-Agent label band
and the remote configuration branch, including at overflow counts.
