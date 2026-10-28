# OAuth reference

[Claude setup](../guides/claude.md) · [CLI](cli.md)

An HTTPS ingress with auth oauth has an ARC-owned authorization server. Secure Tunnel and static Bearer are separate authentication modes.

## Consent

The client starts authorization at the public HTTPS origin. The page shows the client, connection, and callback hostname. **Open ARC** uses `agent-remote-control://oauth?request=<id>` to select the request in the local app. The owner allows or denies it in ARC, or through authenticated CLI. Keep the authorization tab open for callback completion.

The deep link carries only the request ID. The app resolves details from its own Core; a browser on another device cannot approve the remote instance via that device's local app. Closing the dialog postpones the decision. Public endpoints read status and deliver callbacks; approval is available only through local authenticated management.

Tauri registers the scheme in an installed/bundled app. A browser-only development preview does not register it. Client display names are self-reported. Grants authorize the ingress's tool policy and shared task namespace.

## Protocol

- Authorization code flow with mandatory S256 PKCE, exact registered redirect matching, and scope mcp.
- The MCP URL binds the token audience; resource is required on authorization and token requests.
- Access tokens last one hour. Authorization requests expire after five minutes; approved codes after one minute.
- Refresh-token rotation revokes a grant on reuse of an already-used refresh token.
- Token endpoint authentication: none, client_secret_basic, or client_secret_post.
- HTTPS callbacks and HTTP IP-loopback callbacks are accepted; custom schemes and wildcard callbacks are rejected.
- DCR or local preregistration supplies the client identity. Stored tokens/client secrets are hashes; pending approvals/codes are memory-only.

Changing the ingress identity, tool policy, or resource URL invalidates grants while preserving registered clients. Reconnecting at the same identity/resource preserves grants. A client that performs DCR again creates a new client identity and a pending source reservation and needs consent; a matching name is never an identity anchor. Consent may create a new source or reauthorize an existing source of the same product on the same connection. Reauthorization moves the credential anchor after successful code exchange and revokes the old grant, preserving the source ID and history. Refresh rotation keeps the grant and source. Revocation, refresh reuse and code reuse retain the source as revoked.

## Public routes

Forward these paths to the same ingress listener when using a custom reverse proxy:

| Route | Purpose |
| --- | --- |
| `/mcp` | Protected MCP |
| `/.well-known/oauth-protected-resource/mcp`, `/.well-known/oauth-protected-resource` | Resource metadata |
| `/.well-known/oauth-authorization-server` | Authorization metadata |
| `/oauth/register` | Dynamic client registration |
| `/oauth/authorize`, `/oauth/resume` | Authorization and consent page |
| `/oauth/status`, `/oauth/continue` | Status and callback |
| `/oauth/page.js`, `/oauth/tokens.css`, `/oauth/logo.png`, `/oauth/favicon.ico` | Page assets |
| `/oauth/token`, `/oauth/revoke` | Token exchange/refresh and revocation |

Public routes do not expose the management API. Authorization responses are not cached; the page disallows framing and sends no referrer. DCR is limited to 20 requests/hour per running ingress and 128 stored clients. Unused registrations expire after 30 days; existing grants retain their metadata.

## Local management

Use the executable from [CLI](cli.md#executables), with cli followed by:

| Command | Input / result |
| --- | --- |
| ingress oauth list `<id>` | Pending requests and grants |
| ingress oauth request `<id> <request-id>` | pending, approved, denied, completed, or expired |
| ingress oauth decision `<id>` --stdin | `{"id":"<request-id>","allow":true,"sourceId":"new"}`; use an existing source ID to reauthorize; false denies |
| ingress oauth register `<id>` --stdin | client_name, redirect_uris, token_endpoint_auth_method |
| ingress oauth revoke `<id>` --stdin | `{"id":"<grant-id>"}` |

Read the request's client, callback, and resource before deciding. Local OAuth list responses include `sourceId`, `product` and `sourceCandidates` for pending requests. An existing same-product source requires an explicit `sourceId` choice; omission returns `SOURCE_CHOICE_REQUIRED`. If needed, correct the pending source's product before choosing. `cli source claim <pending-source-id> --stdin` accepts `{"sourceId":"new"}` or an existing source ID and approves that request. This is the same local consent boundary, not a public claim route. Repeating a valid identical decision is idempotent; a conflicting decision fails. completed means the client exchanged the code. Verify a real MCP call afterwards.

For public preregistered clients, use token_endpoint_auth_method none; the default is client_secret_basic. A registration response can contain its secret: keep stdout private. Grants report connectedAt from the first successful code exchange and registeredAt separately; refresh preserves connectedAt. Missing historical times remain null.

Source management is available without a running OAuth listener: `cli source list`, `cli source update <id> --stdin` with `label` and/or `product`, and `cli source disconnect <id>`. Disconnection revokes the grant and retains the source record and label. Source product and platform come from the bundled product registry and can be corrected independently of client names. Known client names supply the initial product default on all OAuth connections; unknown clients use the configured product, or custom on shared relays. Client names never establish provider identity. New pending reservations have state `disconnected` and `connectedAt:null`; local OAuth pending requests identify which reservation is awaiting consent. Abandoned reservations are revoked after restart. Historical missing connection timestamps remain null.

## Limits

Client ID Metadata Documents, external authorization servers, per-tool OAuth scopes, and per-user task isolation are not implemented. Initial local consent is required. URL changes, revoked access, or discarded client credentials require a new authorization.

## Request diagnostics

The local diagnostics journal records header names, OAuth registration/authorization/token/revocation field names and JSON types, and authenticated MCP initialization parameter structure. OAuth metadata identifies fields outside the endpoint's recognized protocol fields. These observations do not change request acceptance or establish account identity. Client names identify software, not the signed-in provider account.

Use query `logs` with `ingressId` and `grep:"Ingress"`. `request_received` contains header names; `request_metadata` contains `oauthEndpoint` and `location`, or `stage:"mcp-initialize"`. `traceId` joins these rows to HTTP status and completion timing. `oauthClientHash` is a SHA-256 reference to the public client identifier, linking registration, authorization, token exchange and authenticated MCP requests without retaining that identifier. Authenticated MCP rows include the server-owned `grantId` when available. Token exchanges identify only the recognized authorization-code or refresh flow, never an arbitrary grant-type value.

Values, full URLs, credentials, OAuth state, authorization codes, PKCE values, cookies, tool arguments and responses are not retained. Schemas retain at most 64 nodes, three nesting levels and three sampled array items. Names must be ASCII letters, digits, underscores, hyphens or dots and at most 64 bytes; other names are omitted. Counts expose omitted fields, items and header names. Malformed or rejected-before-parse bodies have no schema. Absence from a truncated schema is not evidence that a field was absent from the request. Header names alone do not reveal their values.

The existing private local journal retains up to seven days with a 16 MiB storage budget. Old payloads cannot be reconstructed. A new authorization or subsequent MCP initialization is needed to observe fields not recorded previously; ARC never reauthorizes a source automatically to collect diagnostics.

## Pairing display

Each pending authorization has a stable four-character `pairingCode`, shown both by
`/oauth/status` and local request/list responses. It excludes ambiguous characters and
is only a visual comparison aid; request identity, PKCE, consent, expiry and token
validation continue to authorize the connection. A retry of the same pending request
keeps its code. Pairing codes do not select or merge source identity. ARC displays consent inline during
control-source setup, or in a dialog for other requests, and notifies in the background.

## Change connection

Run `cli source switch <sourceId> <ingressId>` before removing the old ARC connector in the client and adding it again with the target address. Editing the URL also works when the client supports it. The next new authorization on the target connection exposes `switchSourceId`; consent must claim that source, never `new`. Re-adding may register a new DCR `client_id`. The expectation is keyed to the target connection, not the old client ID, so the new client's authorization is bound to the existing source. DCR registration alone does not consume the expectation; the next authorization request binds it. Compare the pairing code and approve only the intended client.

The source list exposes `pendingSwitch` with the target, expiry, and bound request ID. Use `cli source switch <sourceId> --cancel` to cancel. Expectations last 300 seconds and do not survive Core restart. Denial, cancellation, and expiry preserve the old connection. The source anchor moves only after approval and successful PKCE exchange. It immediately invalidates the former grant for access, refresh, and events; the old OAuth store prunes that grant on its next access. Source identity and all source-keyed records remain unchanged.

Connection removal revokes credentials and retains established sources as disconnected. Their stored names and history remain available, and a later switch reattaches them. Already revoked records remain revoked. See [CLI](cli.md#control-source-management) for request shapes and non-OAuth boundaries.
