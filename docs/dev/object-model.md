# Object model and management surfaces

> Status: target. Implementation replaces the conflicting UI placement in `ui.md`, `remote-link.md`, `accounts.md` and `component-spec.md`, then folds this document into them.

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

This document defines what a user manages in ARC and where each object is managed.

## Principle

- The UI exposes only the basic path for each task. The core, CLI and AX stay fully capable.
- Advanced configuration and alternate methods MUST NOT have UI entries, including disabled, collapsed or "advanced" ones. User documentation describes them as text so the user's own Agent can configure them through CLI or AX.
- The UI MUST still display the real state that advanced configuration produces, read-only, so the topology and panels never contradict the core.
- A surface that only restates another surface is removed, not linked.

## Model

| Asset | Code names | Meaning |
| --- | --- | --- |
| SRC | control source, `source` | A model-facing client account that sends work to ARC (e.g. one claude.ai account). |
| AGENT | agent, agent profile | A controlled executor on this computer (Codex, Claude Code, Pi/ACP agents). |
| TUNNEL | connection, `ingress` | How a SRC reaches this computer. |

- ACCOUNT is the second level of SRC and AGENT, not a standalone asset. One identity MAY appear on both sides.
- SRC and AGENT are management categories. On the homepage, roles come from each dispatch: any conversation can be a dispatcher, an executor, or both in a chain. See [Arena homepage](arena.md).
- TUNNEL has no homepage node.

## TUNNEL in the UI

The UI knows exactly two connections:

- Local: local clients on this computer.
- Public link: one relay this computer deploys to the user's Cloudflare account with one action. Every remote SRC uses it.

The core keeps every connection kind, multiple connections per computer and per-source connection binding. Custom addresses, dedicated tunnel providers, OpenAI Secure Tunnel, joining a shared relay, relay hosting, invite links and member devices are CLI/AX only.

- When the core has connections beyond Local and the public link, the Connections page lists them as read-only rows with kind, address and state. They have no edit, switch or remove actions in the UI.
- A SRC never chooses a connection in the UI. Remote SRCs bind to the public link, local clients to Local.

## Placement rules

- SRC and AGENT are managed only from the homepage topology. They have no dock page.
- Each object has exactly one inspect/edit surface.
- Creating happens in a centered dialog. Existing objects are inspected in side panels or the Connections page.
- Actions and display options sit on the object they affect. There is no central display-settings panel.
- The hub left half opens Add SRC. The hub right half opens Agent settings.

## Dock

The dock contains, in order: Logs, Connections, Settings.
The Tasks, Accounts, Remote link and Permissions pages are removed.
Deep links, Tauri `navigate` events and tray items that targeted removed pages MUST redirect: `tasks` and `accounts` → homepage, `remote` → Connections, `permissions` → Settings.

## Homepage

The homepage is the [arena](arena.md): account candidates at the top, cloud left and local right, and live loops on the stage.

## Homepage panels

SRC panels dock left; AGENT panels dock right. A side panel is a drill-down stack L1 → L2 → L3 with a back control. These panels stay until the management UI is removed.

- Clicking a candidate opens its account panel.
- Clicking an executor bubble, or an Agent dispatcher node, opens the L3 task detail layer.
- Wires are not clickable.

### SRC L1 — platform

- Add account: the `+` action on the account list header opens Add SRC with the platform preselected.
- Account list: alias and state. A row opens L2.

### SRC L2 — account

- Account state and last seen.
- Conversation list for this account. A conversation with an ARC task opens its L3 task detail on the AGENT side.
- Rename inline on the alias and remove from the `⋯` menu.

### AGENT L1 — platform

- Header: name and version.
- Add account: the `+` action on the account list header opens the existing login flow for this agent.
- Account list: alias, state and quota icon. A row opens L2.

### AGENT L2 — account

- Account state and quota.
- Task list for this account. A row opens L3.
- Rename inline on the alias and remove from the `⋯` menu.

### L3 — task detail

Unchanged. It replaces the removed Tasks page.

### Agent settings (hub right)

Lists agents discovered on this computer with enable/disable and order. A compact list of official setup links is allowed without installation-status rows. It does not manage accounts or tasks.

### Add SRC (hub left)

1. Choose the product.
2. Remote products: copy the public link's MCP URL into the client, then approve the pairing request. Without a public link, the first step deploys it.
3. Local clients: show the local setup command.

There is no connection choice, change-connection flow or product correction in the UI.

## Connections page

- Public link: address with copy, state, and a start/stop switch. When it does not exist, one action deploys it.
- Local: state.
- Read-only rows for connections configured through CLI/AX.
- One short text line points to the user guide for other connection methods.

## Settings

- General: task behavior, startup, notifications and language.
- Appearance and app updates.
- System permissions: one entry for the OS permissions ARC needs.

A setting stays in the UI only when most users need it. Others move to CLI/AX.

## Logs

Log rows: time, source name when known, op and result.

## Removals

- Pages: Tasks, Accounts, Remote link, Permissions.
- Connection UI: Add connection, Change connection, connection edit forms, provider forms, Secure Tunnel setup, joined relays, relay hosting and member devices.
- Permission UI: OAuth grant lists and tool policy. Connections always grant full tool access.
- Account UI: merge, notification binding, default-account switch and dispatch policy summary.
- Every removed capability remains available through CLI/AX and is documented in the user guides.

## Acceptance

Use `npm run dev:ui` connected to the running app's real data to exercise changed surfaces. See [Acceptance](acceptance.md).
