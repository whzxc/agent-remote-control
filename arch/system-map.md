---
owners:
  - internal/core/front_door*.go
  - internal/core/service.go
  - internal/core/ingress*.go
  - internal/core/relay*.go
  - internal/core/codex_host*.go
  - internal/core/control.go
  - internal/core/desktop*.go
  - internal/core/rpc.go
  - internal/core/task_host*.go
  - cmd/arc-desktop/**
  - internal/core/desktop_client.go
  - ui/nativeBridge.ts
status: Approved
---
The MCP hub is experimental. It is off by default and enabled from Experimental settings.

Local Agents execute on their single native installation and login without ARC-managed multi-account execution pools or secondary Codex App Servers. Multi-account LLM routing is delegated to an optional local gateway (such as Magpie) when configured by the user; Core probes the gateway locally for aggregated pool quotas and per-turn usage backfill and falls back silently to native behavior when absent. Claude CLI profiles remain scoped strictly to L1 control-source notification push.

Desktop execution uses the Codex local daemon when Desktop is configured to share it. Core connects to that daemon as a client and opens the same native thread in Desktop. Compatible Desktop builds can use Desktop IPC. The ARC App Server remains the owner for background execution.

Device link adds a device tier within the existing control-source/executor topology.
Controller-side local Agents remain tier-1 executors without a local-device wrapper.
Paired devices are tier-1 siblings, followed by their Agents.
Exactly one remote Agent merges with its device node. On a member, the controller device is a tier-1 control source;
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
working node capsules without adding task children, queues or task arcs. Offline task state is
unconfirmed with no live counts. Task presentation moves to Tasks mode.

Desktop offers a manually selected, persisted Topology or Tasks homepage mode.
Task observations update node capsules or task cards without switching modes.
See [Homepage modes](mechanisms/homepage-modes.md) for task origin chains, node-scoped
navigation and the separation of presentation from dispatch ownership.
