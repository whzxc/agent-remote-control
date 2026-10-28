# Remote link: sources, connections, and relay hosting

[UI](ui.md) · [Architecture](architecture.md) · [OAuth](../reference/oauth.md)

MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

This document defines the target model for how control sources reach ARC and how the Remote link, onboarding, and relay-hosting surfaces present it. Phases at the end define the implementation order.

## Problem

ARC has one first-class object, the ingress. A tunnel ingress was historically treated as one control source. A relay ingress carries many OAuth grants, so the UI treats each relay grant as a source while treating each tunnel ingress as one source. Two identity rules coexist for the same concept.

Task provenance stops at the ingress. `origin` is `{ingressId, controlSource, authType}`. Two accounts of the same product on one ingress share notification bindings, governance buckets, respond-token isolation, dispatch-queue isolation, and dispatch records. `controlSource` is ingress configuration, so a relay ingress reports `shared-relay` instead of the calling product.

The Remote link workspace flattens three unrelated concerns: relay deployment and sharing, per-ingress addresses, and a cross-ingress list of OAuth grants without ownership. Adding a source has four entry paths with different behavior.

## Model

Three layers are independent. Each surface MUST present exactly one layer as its subject.

### Control source

A control source is one account, bot, or local client that dispatches work. Two accounts of the same product are two sources. Two products of one vendor are two sources.

| Field | Meaning |
| --- | --- |
| id | Stable ARC source ID. |
| ingressId | The connection that carries it. |
| credential | `oauth-grant` with grant ID and client ID, or `ingress` for non-OAuth ingresses, or `local` for local clients. |
| product | Registry ID from `shared/control-sources.json`, such as claude, chatgpt, gemini, grok, grok-bot. |
| platform | Vendor from the registry, such as anthropic, openai, google, xai. |
| label | User-editable display name. Defaults to the product name plus a disambiguating suffix. |
| createdAt, connectedAt, lastSeenAt | Lifecycle times. |
| state | connected, disconnected, or revoked. |

The credential is the identity anchor. OAuth client names are self-reported and MUST NOT identify a source or provider account. For every OAuth transport, a known registry match on the client name supplies the initial product default. Unknown clients use the configured connection product, or custom on shared relays. Product and label are user-correctable at any time.

The registry gains a `platform` field per product. Display layers MAY aggregate sources by platform. Storage, provenance, and isolation MUST use the source ID.

### Connection

A connection is an ingress: how this computer is reachable. Kinds are Local, Relay link, Dedicated tunnel (Cloudflare, ngrok, Pinggy, LocalXpose, custom proxy), and OpenAI Secure Tunnel. Users choose freely. ARC MUST NOT migrate sources between kinds.

A relay link is one kind regardless of who deployed the relay. Using a relay deployed by this computer and joining a shared relay are the same connection kind. One connection MAY carry many sources.

### Relay hosting

Relay hosting is owner-side infrastructure management: relays this computer deployed, Worker version and updates, the invite link, and member devices. It has no relationship to sources or connections. When this computer uses its own relay, that use is an ordinary Relay link connection, and this computer appears as one member device.

## Identity and provenance

Core owns a source store in the state directory. The UI preference `arc.approved-source-labels` is removed after migration.

- `authenticate` MUST return a principal instead of a boolean. The principal is the grant for OAuth ingresses and the ingress for other auth modes.
- `origin` becomes `{ingressId, sourceId, controlSource, authType}`. `controlSource` is the source's product.
- Notification bindings, governance buckets, respond tokens, dispatch-queue isolation, dispatch receipts, and task origin MUST key by sourceId. ingressId remains for connection diagnostics.
- `limit_wait` and other per-product behavior MUST read the source's product.
- Refresh-token rotation keeps the grant and therefore the source.
- A new grant from repeated DCR creates a pending source. Consent MUST let the owner choose a new source or reauthorize an existing source on the same connection. Reauthorization moves the anchor to the new grant and revokes the old grant. History stays with the source.
- Changing a source's connection is a reauthorization on another connection. The switch flow binds the expected grant to the source before approval, so consent claims it without offering New source. The claim MUST move `ingressId`, keep source ID, label, history, notification bindings and dispatch records, and revoke the old grant only after the new grant is approved.
- Removing a connection marks its sources disconnected and revokes their grants. Source records, labels and history remain, and a later connection switch can reattach them.
- Disconnecting a source revokes its grant. The source record remains as revoked so history keeps its label.
- Non-OAuth connections carry exactly one source.

### Migration

One-time migration runs at Core startup after the state lock.

1. Each existing OAuth grant becomes a source. Product comes from the UI label preference when present, otherwise from a known registry match on client name, otherwise from the ingress `controlSource` for non-relay ingresses or custom for shared relays.
2. Each non-OAuth ingress becomes one source with the ingress's `controlSource` as product.
3. Labels default to the ingress name for single-source ingresses and to the product name plus connection date otherwise. Add numeric suffixes to colliding migration-generated defaults on the same ingress. Renamed labels are not rewritten; version-1 repair only disambiguates labels that still equal the exact legacy generated default.
4. Existing records with only ingressId map to a source only when that ingress has exactly one source. Others remain unattributed. Provenance MUST NOT be inferred. Drop unattributable subscriptions, governance controls, and respond tokens. Keep unattributed bindings and dispatch history inert; fail active unattributed queue rows with `source-unattributed`.
5. Delete migrated preference keys and obsolete fields. Keep no aliases. Persist the migration version only after notification migration and row decoding succeed. Version 2 repairs incomplete version-1 migrations without regenerating source IDs or overwriting renamed labels. Interrupted steps are safe to re-run. Malformed notification rows are skipped individually without rejecting valid siblings.

### Management surface

Local management adds `source list`, `source update` (label, product), `source disconnect`, and `source claim` for pending reauthorization. `source switch <sourceId> <ingressId>` registers an expected cross-connection claim; `source switch <sourceId> --cancel` cancels it. The CLI mirrors them under `cli source`. Control-source tools stay frozen. Receipts and task reads expose `origin.sourceId` and the source label.

## UI

### Remote link workspace

The workspace subject is control sources and how each one connects.

- The primary list shows one row per source: product icon, label, connection chip, and state. A persisted toggle groups rows by platform.
- Selecting a source opens its activity panel. Its platform icon opens the platform panel, which shows accounts and quota with a platform runtime switch. Connection configuration stays in the Connections workspace.
- A Connections section lists one row per connection: kind, address, health, and the number of sources it carries. Selecting a connection opens its detail: address copy, provider, edit for dedicated tunnels, retry or update for relay links, and Leave for joined relays.
- Pending reauthorizations appear on the affected source row until claimed or dismissed.
- Grants without a source cannot exist after migration. The separate Approved list is removed.
- Relay deployment, sharing, and member devices do not appear in this workspace.

### Placement rule

Creating something new or approving something that just arrived happens in a centered modal dialog. Existing objects are inspected and edited in side panels and workspace panels. Add flows MUST NOT open in side panels.

Three centered dialogs exist: Add control source, Add connection, and Change connection. They share one shell: `clamp(560px, 44vw, 720px)` wide, capped to the viewport with 20px side margins (stacked layers use 92% of that width), 20px radius, title row with close, a segmented step bar whose completed segments show the chosen value ("Platform · Claude"), content-sized height up to the viewport minus 96px, and a footer with Back on the left and the primary action on the right. Steps that complete on an external event (client authorization, relay deployment) show a waiting indicator in the footer instead of a primary button and advance automatically.

Choice grids and radio rows fill the body width. Completed step labels wrap instead of truncating the chosen value. Every step grows with its content; only the body scrolls when the viewport cannot fit it. Inner spacing and platform tiles scale modestly with the viewport; the platform grid keeps three equal columns. Local Claude Code and Claude Desktop remain separate choices. Workspace entry points keep the workspace mounted behind the dialog; dismissal restores the trigger or a visible equivalent. Source completion returns to the homepage for the new-node highlight.

Add connection MAY stack on top of Add control source or Change connection. The parent dialog stays mounted, scaled to 0.95 and shifted up without dimming or a visible scrim. The stacked dialog shows "Returns to <parent title> when done". Completing it closes only the stacked layer and selects the new connection in the parent. Closing it returns to the parent unchanged. Escape closes one layer.

The design reference for all dialogs and panels is the canvas "ARC onboarding and source setup v2". A static copy of its markup lives outside the repository at `~/Developer/research/arc-remote-link-v2/reference.html`; it is a visual reference, not code to import.

Run `npm run accept:ui -- --setup-only --no-screenshots` for setup layout acceptance at 640×800, 1280×800 and 1920×1080. Standard steps MUST fit without body scrolling at the two larger viewports. The 640px check permits vertical scrolling and rejects horizontal overflow. Stacked layers MUST remain narrower than their recessed parent.

### Add a control source

The left center dot, Remote link › Sources › Add, Welcome, and Connection detail › Add a source for it open the same dialog. Steps: Platform, Connection, Configure, Approve.

1. Platform: a three-column grid of 48–58px tiles with brand icon and name, in two groups. The title is "Add control source" until selection, then "Add <platform>". "Phone and web" lists Claude, ChatGPT, Gemini, Grok, Grok Bot, Copilot. "This computer" lists Claude Code, Claude Desktop, and Other MCP client (dashed). Selection uses a 1.5px text-color border. Opening from Connection detail preselects that connection and skips step 2.
2. Connection: "Which connection should <platform> use to reach this computer?", then one radio row per existing connection with name, kind, the sources it already carries, and online state. Incompatible connections stay visible, disabled, with the reason ("ChatGPT only"). A row whose OAuth connection already carries a source of the same product shows a separate warning-colored line that approval will offer New account or Reauthorize. A full-width dashed New connection row has a left-aligned title and description and stacks Add connection. With no compatible connection, the step shows "No connection yet" with Create my relay (recommended, emphasized) and Join a shared relay / Use your own address rows, each opening Add connection directly at that method's configuration. Local products show only their local connection, and a missing one is installed by Add connection's local method.
3. Configure: numbered instructions from the registry: copy the address, the platform's settings path with an Open settings button, then "Click Connect in <platform>; the browser shows a 4-character code". The footer waits for the client and advances to Approve when a new pending request appears.
4. Approve: the pairing code in large monospace on a subtle panel, an account name field defaulting to the product name plus a disambiguating suffix, the New account / Reauthorize choice when applicable, origin and capability line, and Deny / Approve. ARC also posts a system notification "<Platform> requests a connection · code 4F7K" that focuses this step.
5. Done: success mark, "<label> connected", the connection used, a copyable first prompt, and Add another / Done. After closing, the new node grows into the homepage left wing and stays highlighted for about 2 seconds.

Non-OAuth sources skip Approve and complete on an observed client connection, as before.

### Add a connection

Remote link › Connections › Add connection opens it standalone. Add control source step 2, Change connection step 1, and Welcome (through Add control source) open it stacked. Steps: Method, Configure, Ready.

1. Method: radio rows for Create my relay (recommended), Join a shared relay, Use your own address, OpenAI Secure Tunnel, and the local Claude Code/Desktop method. When opened for a product, incompatible methods stay visible and disabled with the reason. Create my relay's primary action reads "Sign in to Cloudflare and deploy" with an external-link icon.
2. Configure: Create runs the existing RelayProgress (sign in, deploy, connect this computer) with account change, copy-login-link fallback and cancel; it advances automatically. Join asks for the invite link and this computer's device name, and says the host only sees the name and online times. Own address shows provider pills (Cloudflare Tunnel, ngrok, Pinggy, LocalXpose, other reverse proxy), domain without scheme or path, connection name, and a collapsed Advanced section for authentication; it reuses IngressDialog's form logic and native validation. Local installs the client configuration.
3. Ready: success mark, connection card with name, monospace address, online state and source count. Stacked: the only action is "Continue with this connection". Standalone: Done and "Add a source for it".

### Change a source's connection

Source activity panels link to platform panels for accounts and runtime controls. Connection configuration stays in the Connections workspace. Cross-connection source migration starts through management ops or CLI. The pending migration dialog uses Connection, Update address and Reauthorize steps.

1. Connection: "Currently via <name>", compatible connections as radio rows, disabled incompatible ones and non-OAuth connections that already carry a source, and a dashed New connection row that stacks Add connection. A warning note uses the registry's `setup.editableUrl` capability: unless explicitly true, remove the old ARC connector in the platform and add it again with the new address (editing the URL also works where supported). It explains that reauthorization is required, that name, history and notification settings are kept, and that the old grant is revoked after success.
2. Update address: the new address with Copy, the same registry-driven replacement instruction, and the platform's settings path. The footer waits for a request on the new connection.
3. Reauthorize: pairing code, a body-size fixed chip "Claim as <label>" without the New account option, and a line naming the old connection and the sources that remain on it. Client and permission facts use 12px secondary text; the remaining-sources sentence uses 13px text. No callback URL is shown. Deny / Approve and switch. Success returns to Source detail with the connection card updated.

### Connection detail

Selecting a connection row opens Connection detail inside the Remote link workspace: kind icon, name, provider line, state pill, MCP address with Copy, "Sources using it" list linking to Source detail, "Add a source for it", provider facts, and for relays this computer hosts a link to Settings › Extras › Relay hosting. A bottom card removes the connection after a confirmation that names the affected sources and states that their names and history remain. Joined relays show Leave relay instead. Deleting a hosted relay itself stays in Relay hosting.

### Homepage

Each source is one node, including multiple sources on one connection. Grouping by platform MAY be added later as a display option. Recent dispatches in a source panel filter by sourceId.

### First run

Welcome is a full-window page: ARC mark, "Where do you command Codex from?", the subtitle "Start with one. You can add the other anytime.", two choice cards (This computer: Claude Code · Claude Desktop, about 1 minute, no network setup; Phone and web: Claude · ChatGPT · Gemini · Grok, about 3 minutes, free Cloudflare account), and a quiet footer with clickable Codex login and permissions readiness dots plus "Have a relay invite link?". Both cards open Add control source with the matching platform group focused; the invite link opens Add connection at Join. Copy assumes a practiced user and is not measured. Automatic opening waits for a successful source-list read before deciding whether sources exist. An earlier status snapshot does not establish an empty source list. It does not replace an open setup or detail view.

### Settings: Extras

Settings shows one entry row for Extras. Extras opens a nested view inside the Settings workspace, with a Settings / Extras header and back navigation. A 200px sub-navigation selects Relay hosting or Experimental topology controls and stacks above the content below 640px.

Relay hosting lists only relays this computer deployed. Cards show the hostname, state, Worker version with Update when outdated, and an invite footer with Copy and Reset. Full tokenized URLs are never rendered. Reset invalidates the old invitation without disconnecting existing devices. Member tables show device names, compact joined and last-seen times, and Remove with confirmation. This computer uses status.deviceName, is marked This computer, and has no Remove action. Create and join register the device name. Delete is a separate bottom danger zone with confirmation that every connected device loses its relay connection. Deploy new relay reuses the deployment progress flow.

## Phases

- P0: source store, principal-returning authentication, `origin.sourceId`, keying changes, reauthorization claim at consent, migration, management API, and CLI. Accept through CLI and a real remote OAuth call on two sources sharing one ingress.
- P1: Remote link workspace, shared Add flow, source and connection details, and one homepage node per source.
- P2: Settings Extras with Relay hosting and Experimental controls, trimmed Welcome, and synchronized user documentation.
- P3: dialog redesign per the placement rule: shared dialog shell and stacking, Add control source and Add connection rebuilt to the new steps, new Welcome page, Connection detail, and homepage grow-in highlight. Accept through UI scenarios for every dialog step in light and dark.
- P4: Change connection: cross-connection claim in Core, management API and CLI (`cli source switch`), the dialog, and connection removal keeping disconnected sources. Accept with a real remote OAuth switch between two connections.

## Limits

Source identity covers OAuth grants, non-OAuth ingresses, and local clients. Two clients sharing one Bearer token or one OpenAI Secure Tunnel are one source. Platform aggregation is a display grouping and never an isolation boundary.

Switch expectations last 300 seconds, allow one source per target at a time, and are canceled on Core restart. Approval retains the existing PKCE boundary: the source moves after successful code exchange, not merely after clicking Approve. The source anchor immediately invalidates old access, refresh, and event credentials; the former OAuth store prunes them on its next access. Existing revoked records stay revoked. Local connections are not switch targets. Non-OAuth connections carrying any source cannot be targets; an empty target completes only on an authenticated client request. A former non-OAuth connection must be removed and recreated before its credentials can establish another source.

Local configuration installation currently supports Claude Code and Claude Desktop. Other MCP client uses manual HTTPS configuration. The registry has no settings URL for every product, so Configure shows the generic MCP settings instruction when a product has no setup metadata.

RelayProgress supports account selection when Core returns multiple Cloudflare accounts, copy-login-link fallback, cancel, and retry. Core does not expose the current signed-in account or a forced account-login change action. The reference's inline signed-in identity and Change action remain unavailable until that contract exists. Own-address forms retain provider-specific domain modes and required credentials; providers collapse to the shared dropdown when pills do not fit.
