---
owners:
  - native/src/front_door*
  - native/src/service.rs
  - native/src/ingress*
  - native/src/relay/**
  - native/src/codex_host.rs
  - native/src/task_host.rs
  - desktop/src/**
status: Proposed
---
The MCP hub is experimental. It is off by default and enabled from Experimental settings.


Device link adds a device tier within the existing control-source/executor topology.
Controller-side local Agents remain tier-1 executors without a local-device wrapper.
Paired devices are tier-1 siblings, followed by Agents and accounts/profiles.
Exactly one remote Agent merges with its device node. Accounts/profiles fold under
space pressure. On a member, the controller device is a tier-1 control source;
its upstream sources are optional tier-2 children, off by default.

Remote dispatch addresses (device, agent). Ops gain a device target argument while
MCP tool structures stay frozen. The Tasks projection includes only tasks that controller
dispatched to that member. The member attributes these tasks to the controller device.
Nesting supports further member relationships, rejects cycles at pairing and renders
one device hop only; protocol forwarding is false. LAN/Tunnel path, latency, last seen
and errors belong to the device node, and offline fades its entire branch. Management
opens from that node. The existing right-wing add endpoint adds Agents or devices.
Experimental marks this proposed device projection; native session ownership is unchanged.

The proposed homepage topology has configuration-only geometry. Task activity updates
node task pills without adding task children, queues or task arcs. Offline task state is
unconfirmed with no live counts. Task presentation moves to Tasks mode.

Desktop offers a manually selected, persisted Topology or Tasks homepage mode.
Task observations update static badges or task cards without switching modes.
See [Homepage modes](mechanisms/homepage-modes.md) for task origin chains, node-scoped
navigation and the separation of presentation from dispatch ownership.
