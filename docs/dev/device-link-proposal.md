# Device link proposal

Status: accepted for phased implementation.
MUST means a requirement. SHOULD means the default unless a concrete task-specific reason justifies an exception. MAY means an option.

[Architecture](architecture.md) · [Remote link](remote-link.md) · [Tool surface](tool-surface.md) · [Architecture assets](arch-assets.md)

## Purpose

One ARC instance, the controller, reaches other ARC instances, the members, so control sources connect only to the controller.
Members are the user's own computers: macOS, Windows or headless Linux.
The controller forwards catalog ops to a member and returns the member's own result.
Each member keeps executing work with its own Agents, logins and native session stores.
LAN is the primary path; a member's existing tunnel connection is the fallback path.

## Scope

Version 1 is one controller per member and one-way control.
A member MUST NOT forward a peer-origin request to another device.
A member MUST NOT control its controller.
There is no member-to-member path, multihop routing, automatic re-routing or federation of coordination state.
The relay Worker and relay membership are not used.
Windows `screen` remains unsupported; members report it as an absent capability.

The feature is an Experimental switch named Device link.
Disabled, its ops are absent from guide and the catalog and return `OP_UNAVAILABLE`, and no peer listener runs.
Enabled, its entry appears in the shared bottom-left navigation capsule.

## Identity

Each instance generates one device key pair on first enable and stores it in the state directory with owner-only permissions.
The device ID is the SHA-256 fingerprint of the public key.
A device name is a display label and never identity evidence.
Rotating the key unpairs every peer of that device.

## Pairing

Pairing requires explicit local consent on the member.
The member starts a pairing offer locally from Desktop or `arc cli device offer`.
The offer is a copyable pairing string containing its device ID, LAN addresses and port, its tunnel URL when present, a protocol version and a one-time secret.
The secret expires after ten minutes or on first use.
The controller connects with the member's fingerprint pinned and proves the secret.
The member then shows the controller's name and fingerprint and requires local approval.
Approval stores the controller's public key on the member and the member's public key, name and addresses on the controller.
Either side MAY revoke the pairing at any time; revocation closes open peer connections immediately.

On the member, the paired controller is one source with credential type `peer` in the existing source store.
Its origin uses the peer source ID, and the member's control profile, receipts and resource boundaries apply unchanged.
Peer-origin requests MUST NOT reach Device link ops, pairing, revocation or other local-management authority.

## Transport

The member's front door owns a peer listener, as it owns other listeners.
The listener binds the configured port on LAN interfaces and accepts only private, unique-local and link-local peer addresses.
It speaks HTTPS with mutual TLS.
Both certificates are self-signed by the device keys and pinned by fingerprint, so no certificate authority is involved.
A handshake failure closes the connection before any request is read.

The fallback path is the member's existing dedicated-tunnel connection on a reserved peer route.
Tunnel TLS terminates at the provider, so the peer route authenticates at the application layer.
The controller signs a member-issued challenge with its device key and receives a short-lived session token bound to its device ID.
Tunnel providers can read peer payloads; end-to-end payload encryption is outside version 1.

Discovery uses DNS-SD service `_arc-peer._tcp` on the LAN.
The advertisement carries only the device ID and protocol version.
The controller resolves a member by device ID, so address changes need no re-pairing.
A manually configured `host:port` overrides discovery on networks that block multicast.
On Windows, installation adds an inbound firewall rule for the peer port limited to the private network profile.

## Path selection and liveness

The controller's Core owns one monitor per paired member.
The monitor sends a heartbeat every 10 seconds on the preferred available path and probes LAN whenever the tunnel path is in use.
LAN wins whenever its probe succeeds.
Three consecutive missed heartbeats, or an immediate connection refusal on every path, mark the member offline.
One successful heartbeat marks it online again with the path that succeeded.
A request already sent on one path never moves to another path.

Offline members are outside dispatch scope.
`devices` and the dispatch decision view list only online members by default; `all:true` includes offline members with their state.
A forwarded request to an offline member fails before transmission with `DEVICE_OFFLINE` and a `query devices` next action.
Work already running on a member keeps running when the member becomes unreachable.
The controller never cancels it, re-dispatches it elsewhere or infers its outcome; reads fail fast until the member returns.

## Catalog ops on the controller

The frozen `guide`, `query` and `act` tools and the `notification` event keep their structures.
New capability arrives only as catalog ops:

| Op | Tool | Result |
| --- | --- | --- |
| `devices` | query | Paired members with ID, name, platform, architecture, ARC version, state, path, last seen, latency and capability summary. |
| `device` | query | Forwards `{device, op, args}` as a member read, including `op:"guide"`. |
| `device` | act | Forwards `{device, op, args}` as a member write. |
| `device_transfer` | act | Streams one file between the controller and a member. |

`device` accepts a device ID or a unique name.
Forwarded results are the member's own contract; the controller does not rewrite them.
A member running a different ARC version is supported as long as the peer protocol version matches; otherwise the request fails with `DEVICE_PROTOCOL_MISMATCH`.
Errors use the existing envelope with a guide next action.

## Receipts

The controller assigns the receipt ID before transmission.
The member records the forwarded write under that same receipt ID in its peer source.
The controller records a bounded forward record: receipt ID, device ID, op, originating source and send time.
A lost response returns an uncertain outcome with a `query device` receipt read action.
Sent writes are never resent.

## Task association and notifications

The member sees one peer source; per-source boundaries are the controller's responsibility.
When a forwarded write creates a task, the controller records the member task ID with the originating source.
Later forwarded reads and writes on that task follow the same task-association rules as local tasks.

The controller keeps one event stream open to each online member over the peer connection.
The member sends task status events for peer-origin tasks on that stream and does not deliver them to its own notification targets.
The controller maps each event to its originating source and delivers it through the existing notification owner and bindings.
After a reconnect, the controller reconciles referenced tasks with fresh reads; there is no replay.

## File transfer

`device_transfer` takes `{from:{device,path}, to:{device,path}, expectedSha256?}` with one side being the controller.
Bytes stream over the peer connection and never pass through a control source.
The receiver writes to a temporary file, verifies SHA-256 and renames atomically.
An interrupted transfer resumes from the receiver's verified offset.
On LAN, ARC imposes no size limit beyond free disk space.
On the tunnel path, the stream is split into ranges that fit the provider's request limits.
The existing receipt lifecycle covers each transfer.

## Data boundaries

Agent sessions, transcripts and history indexes stay in each member's native storage.
The controller stores only pairings, forward records, task associations, liveness state and bounded derived observations.
Each member uses its own Codex, Claude Code and other Agent logins.
Pairing never moves, migrates or deletes native session data.

## Security

A pairing grants the controller full host authority on the member, equivalent to the `command` op.
Compromise of the controller or of a control source with host access therefore reaches every member.
Pairing requires local approval on the member, revocation is immediate on either side, and every forwarded request carries its originating source in the member's receipt for audit.
The peer listener rejects public peer addresses and unauthenticated handshakes.

## Phases

1. Device identity, pairing, LAN listener with mutual TLS, DNS-SD discovery, liveness, `devices`, `device` forwarding with receipts and task association.
2. Tunnel fallback path and member event streams for notifications.
3. `device_transfer` streaming.
4. Desktop Devices workspace and topology nodes, after their design sources are approved.

## Limits

- One controller per member.
- No Windows `screen`.
- Tunnel providers can read peer payloads.
- Members on networks that block both multicast and the peer port need the tunnel path.
