# Manage connections

**English** | [简体中文](../zh-CN/guides/connections.md)

Click the upper arc of the center ring, then **Add connection**. With no connection, the broken arc exposes **Add connection** directly. We recommend one connection per device, reused by every platform. A connection supplies the address and access method; an OAuth connection can carry multiple named control sources.

## Add a connection

Choose a method, complete Configure, then finish on Ready.

| Method | Configuration |
| --- | --- |
| Create my relay | Sign in to Cloudflare; ARC deploys the relay and connects this computer. |
| Paste relay link | Paste an invite link and name this computer. Only join a host you trust. |
| Use your own address | Choose Cloudflare Tunnel, ngrok, Pinggy, LocalXpose, or another reverse proxy; enter the provider credentials, domain and connection name. |
| OpenAI Secure Tunnel | Enter a Tunnel ID and runtime API key. See [ChatGPT](chatgpt.md#advanced-openai-secure-tunnel). |
| Claude Code / Claude Desktop | Install the local client configuration, then restart the client. No network setup is needed. |

Own-address setup shows credentials, authentication and operation permissions directly. Paste a hostname or full HTTP(S) URL into Domain; ARC extracts the hostname. Use OAuth for approval in ARC, or Bearer for clients that send an Authorization header. Provider credentials establish the tunnel; client authentication controls access through it. A fixed domain must already be assigned in the provider account. Choose **Save and start**; ARC manages the required provider process.

When stacked, choose **Continue with this connection** to return with it selected. Standalone setup offers **Done** or **Add a source for it**. Closing the stacked dialog returns without changing the parent selection.

## Add a control source

Use the left dot on the center ring to open product connection guidance. ARC receives a connector after you add the copied address in the product and approve authorization.

1. Choose the platform.
2. Select a compatible connection, or add one.
3. Copy the address and follow the platform settings in Configure. Connect in the client.
4. In Approval, compare the pairing code, check the client and permissions, and enter an account name. Choose **Reauthorize** if you want to keep an existing source on that connection. Approve and finish.

Choosing **Add a source for it** after connection setup preselects that connection. Local clients and connections without OAuth complete after the client connects, without pairing-code approval.

## Connection cards

Click the upper arc to see connection cards with their address, provider and online state. Associated connectors appear as small product logos; hover or focus a logo to see its name. Copy the address directly from the card into the products you want to connect. Edit and remove use icon buttons on the card. Non-local, non-relay connections offer **Edit**.

**Remove connection** disconnects its sources and retains their names and history. Reconnect them with Change connection. Joined relays offer **Leave relay**. A hosted relay has a link to its management page in Settings; deleting the relay itself happens there.

For daily use, choose a fixed address. If a temporary address changes, remove and re-add the client's connector with the new address, or edit its URL where supported, and authorize again. Check the connection card for provider errors; see [FAQ](../faq.md) for client issues.

## Use a custom reverse proxy

Route the public HTTPS hostname to ARC's loopback listener. Give each fixed Cloudflare or custom connection a distinct local port. Forward `/mcp` and every route in the [OAuth reference](../reference/oauth.md#public-routes) for OAuth. Keep ARC's management API private.

## Host a relay for others

Open **Settings → Extras → Relay hosting** and choose **Deploy new relay**. Sign in to Cloudflare and wait for deployment and connection. **Copy invite link** invites another computer. **Reset** invalidates the old invite without disconnecting joined devices.

**Connected devices** lists names, joined time and last seen. **This computer** has no Remove action. Removing another device disconnects it; it can rejoin with a valid invite. **Delete…** disconnects every device, including this computer, and deletes the hosted relay. Removal and deletion require confirmation.

Joined relays remain in the upper-arc connection panel. The homepage topology switch is under **Settings → Extras → Experimental**.

## Limits

Only join trusted relays: their deployer can technically inspect relayed traffic in Cloudflare. ARC uses Streamable HTTP, not a standalone legacy SSE endpoint. LocalXpose temporary mode is unavailable because the first request is redirected. Provider accounts, domains, quotas and outbound connectivity remain your responsibility. None authentication allows anyone who can reach the endpoint to use its allowed tools. Local connections cannot be switch targets; a non-OAuth target must have no source and completes the switch on an authenticated client request rather than OAuth approval.
