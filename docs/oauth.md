# OAuth authentication

An HTTPS ingress can use `auth: "oauth"`. Agent Remote Control（ARC） includes an authorization server; no external identity provider or account database is required. Secure Tunnel and static Bearer authentication remain separate options.

## Connect

1. Select OAuth when creating or editing an HTTPS connection, then start it.
2. Add the MCP URL to the client. The authorization page displays the client, target connection and callback hostname. Keep this page open.
3. On the same device, click **Open ARC**. The `clc://oauth?request=...` link opens the app and selects the local request in a standalone confirmation dialog. Allow or deny there.
4. For a connection hosted on another device, open ARC on that target device and confirm its pending request, or use the target device's authenticated CLI. A deep link always opens the app on the browser's device, not a remote device.
5. The web page reads back the decision and returns to the registered callback automatically. A manual return link is also available.

There is no authorization password or web login session. The public web endpoints can only read request status and deliver the OAuth callback; they cannot approve or deny. Local app and CLI decisions use the authenticated management channel. Deep links carry only an opaque request ID, never a decision, client description or remote management address. The app resolves all details from its local service. Unknown or expired requests cannot be approved; the app explains how to confirm on the target device. Closing a dialog postpones the decision; it does not grant or deny access. Pending requests appear when the target app's main view is opened. The connection details retain cards for authorized clients and revocation actions at the bottom.

The desktop registers `clc` through Tauri's deep-link plugin and forwards launches to the existing app instance. Scheme registration requires a bundled/installed app; a browser-only Dev preview does not register an OS protocol. Browsers may ask permission to open the app. After confirmation, return to the original browser tab; its polling completes the redirect without opening duplicate callback tabs.

Client names are self-reported. Grants authorize the ingress's allowed tools and shared tasks, not a separate user workspace. Changing the ingress identity, tool policy or public URL revokes grants but preserves registered clients. Keep a stable HTTPS hostname so clients do not need URL updates.

## Protocol and routing

The authorization server implements authorization code with mandatory S256 PKCE, exact registered redirect URI matching, audience binding to the ingress MCP URL (`resource` is required on authorization and token requests), the `mcp` scope, and refresh-token rotation. Access tokens expire after one hour; grants remain valid until manually revoked or invalidated by security or connection changes. Used refresh tokens trigger grant revocation on replay. Repeated authorization URLs with the same client, redirect URI, state, PKCE challenge and resource reuse the same pending request. Independent authorization transactions remain separate. Authorization requests expire after five minutes and approved codes after one minute. Access tokens, refresh tokens and client secrets are persisted only as hashes in the ingress's private state directory; pending approvals and codes are memory-only.

Public routes on the same HTTPS origin:

- `/mcp`: protected MCP endpoint.
- `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource`: resource metadata.
- `/.well-known/oauth-authorization-server`: authorization server metadata.
- `/oauth/register`: dynamic client registration (RFC 7591).
- `/oauth/authorize` and `/oauth/resume`: authorization request and web consent page.
- `/oauth/status`: request readback (`pending`, `approved`, `denied`, `completed`, `expired`).
- `/oauth/continue`: returns the authorization response to the registered callback.
- `/oauth/page.js`, `/oauth/tokens.css`, `/oauth/logo.png`, `/oauth/favicon.ico`: bundled page assets.
- `/oauth/token`: code exchange and refresh.
- `/oauth/revoke`: token revocation.

A custom reverse proxy or path-restricted named tunnel must forward all these routes to the same ingress listener. Managed whole-host tunnels already forward the routes. The target device owner confirms inside the local app or authenticated CLI. OAuth browser endpoints never expose the local management API.

Clients can use `none`, `client_secret_basic` or `client_secret_post` token endpoint authentication. HTTPS callbacks and HTTP IP-loopback callbacks are accepted; custom URI schemes and wildcard callbacks are not. Client ID Metadata Documents, external authorization servers, per-user task isolation and per-tool OAuth scopes are not implemented. Register clients with DCR or local preregistration instead. A client's OAuth support does not establish end-to-end compatibility with every provider.

The implementation bounds stored clients, pending requests and grants. Dynamic registration is limited to 20 requests per hour per running ingress and 128 stored clients. Unused registrations expire after 30 days; existing grants keep their client metadata. Authorization and token responses are not cached. The authorization browser page disallows framing and sends no referrer.

## Local preregistration and management

Use the installed executable's CLI. Sensitive input goes through stdin, and the registration response contains the client secret when applicable; keep that response out of shared logs.

- `cli ingress oauth list <id>` lists pending requests and grants. Grants are ordered newest first and expose `connectedAt` (Unix seconds of the successful initial code exchange) and `registeredAt` (client registration time). Refreshing a token preserves `connectedAt`. Historical grants without a saved connection time return `null`; the UI labels their registration time separately.
- `cli ingress oauth register <id> --stdin` accepts JSON containing `client_name`, `redirect_uris` and `token_endpoint_auth_method`. For public clients, specify `"none"`; otherwise the default is `"client_secret_basic"`.
- `cli ingress oauth revoke <id> --stdin` accepts `{"id":"grant-id"}`.

- `cli ingress oauth decision <id> --stdin` accepts `{"id":"request-id","allow":true}` (or false). It returns the resulting request status, not an authorization code. Repeating the same decision is idempotent while the request is valid; conflicting decisions fail.
- `cli ingress oauth request <id> <request-id>` reads the specific request state. `completed` means the client exchanged its authorization code, not that a tool or task has been verified.

Read the pending request and its client/callback/resource before deciding. CLI decisions use the existing authenticated local management channel; do not expose it publicly. After an unknown write outcome, read the same request instead of creating another one. App/CLI authorization does not substitute for real client tool and task acceptance.

Reconnecting an ingress at the same MCP URL preserves its OAuth grants. Clients can reuse their access token or obtain a new one with their refresh token, without a new registration or consent. A client-side reconnect that performs dynamic registration again creates a distinct client identity and requires consent; matching display names or callback URLs do not prove it is the previously authorized client. Agent Remote Control cannot recover credentials discarded by the client. Changing the resource URL or revoking access requires a new authorization.
