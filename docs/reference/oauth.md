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

Changing the ingress identity, tool policy, or resource URL invalidates grants while preserving registered clients. Reconnecting at the same identity/resource preserves grants. A client that performs DCR again creates a new identity and needs consent; a matching name is not an existing registration.

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
| ingress oauth decision `<id>` --stdin | `{"id":"<request-id>","allow":true}`; false denies |
| ingress oauth register `<id>` --stdin | client_name, redirect_uris, token_endpoint_auth_method |
| ingress oauth revoke `<id>` --stdin | `{"id":"<grant-id>"}` |

Read the request's client, callback, and resource before deciding. Repeating a valid identical decision is idempotent; a conflicting decision fails. completed means the client exchanged the code. Verify a real MCP call afterwards.

For public preregistered clients, use token_endpoint_auth_method none; the default is client_secret_basic. A registration response can contain its secret: keep stdout private. Grants report connectedAt from the first successful code exchange and registeredAt separately; refresh preserves connectedAt. Missing historical times remain null.

## Limits

Client ID Metadata Documents, external authorization servers, per-tool OAuth scopes, and per-user task isolation are not implemented. Initial local consent is required. URL changes, revoked access, or discarded client credentials require a new authorization.
