# View ARC remotely

Open a read-only ARC dashboard through an existing HTTPS connection or ARC relay.
The dashboard shows connection health, Agent activity, quotas, and live task timelines.

## Get an access link

Run this command on the computer running ARC:

```sh
arc cli call browser.access
```

Read `result.links` for the configured connection URLs. Open a URL ending in
`/?key=arc_…` in your browser. Keep the key URL when bookmarking the page.
The key is generated on the first local request and persists across ARC restarts.
It applies to this ARC instance's HTTPS connections and relays.

The document always requires a valid key in its URL. Missing or invalid keys
receive HTTP 401 with an empty body. Authorized pages use a secure, HttpOnly
session cookie for their assets and live data. Responses disable caching and
referrers. ARC ingress logs do not record the key or request query.

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
- Local files and local images in conversations are not opened through the browser.
- ARC Core and the selected tunnel must remain running. A disconnected page retains its last snapshot and shows the connection error.
- Source builds must build the frontend before compiling Core to embed the webpage. Official desktop and Linux build entry points do this automatically.
