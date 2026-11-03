# View ARC remotely

Open a read-only ARC dashboard through an existing HTTPS connection or ARC relay.
The dashboard reuses the desktop topology, panels, account views, conversation
list, and task timeline. Write controls are disabled.

## Get an access link

Run this command on the computer running ARC:

```sh
arc cli call browser.access
```

Read `result.links` for the configured connection URLs. Open a URL ending in
`/?key=arc_…` in your browser. ARC saves the key in LocalStorage and immediately
removes it from the URL. Bookmark the clean address after signing in.
The key is generated on the first local request and persists across ARC restarts.
It applies to this ARC instance's HTTPS connections and relays.

The first visit requires a valid key URL. ARC also sets a persistent Secure,
HttpOnly, SameSite=Strict session cookie so reopening or refreshing the clean
address stays authenticated. API requests use the stored key; assets and streams
use the cookie. Requests without valid credentials receive an empty HTTP 401. Responses disable HTTP disk caching and referrers. The current page reuses
unchanged read results in memory. Status changes arrive over a compact stream;
unchanged reads transfer no response body. ARC ingress logs do not record the key or request query.

## Replace the key

```sh
arc cli call browser.access.rotate
```

Use the replacement URLs from `result.links`. Old links and sessions stop working.
Active streams close at their next authentication check, within two seconds.

## Configure the connection

Managed HTTPS tunnels forward the webpage through their existing address and
process. ARC relay links include the instance path, such as `/u/<instance>/`.
For a custom reverse proxy, forward `/`, `/assets/*`, and `/view-api/*` to the
same ARC ingress listener as `/mcp`. Allow streaming responses on `/view-api/*`.
Keep the local management listener private.

## Limits

- OpenAI Secure Tunnel carries MCP and cannot serve this webpage. Add an HTTPS connection if it is your only connection.
- The browser can inspect state and expand task details. It cannot send messages, answer requests, change configuration, refresh upstream quotas, or start and stop connections.
- Local images retain the task resource boundary. Opening a file on the host is unavailable.
- ARC Core and the selected tunnel must remain running. A disconnected page retains its last snapshot and shows the connection error.
- Source builds must build the frontend before compiling Core to embed the webpage. Official desktop and Linux build entry points do this automatically.
