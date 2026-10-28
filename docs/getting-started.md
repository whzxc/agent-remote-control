# Your first Claude + Codex loop

**English** | [简体中文](zh-CN/getting-started.md)

Call `guide` first for this connection’s workflow, enabled ops, and examples. Use `guide({"op":"codex_create"})` for the full schema. Invoke operations through `query({"op":"…","args":{…}})` or `act({"op":"…","args":{…}})`; reread `guide` when a result’s `arcVersion` changes.

## Install and connect

[Install ARC](installation.md), open it, and sign in to Codex. Click the upper arc of the center ring to manage connections. With no connection, the broken arc shows **Add connection**. We recommend one connection per device, reused by all platforms. Use the left dot to copy a connection address for a product and approve its connector after the product connects.

### Add a control source

1. **Platform:** choose the client you use.
2. **Connection:** select an existing connection. **Add connection** opens Add connection above this dialog; finishing returns with the new connection selected. With no compatible connection, choose a relay or your own address.
3. **Configure:** copy the address, open the platform settings shown in ARC, and add the ARC connector. Click Connect in the client.
4. **Approval:** return to ARC, compare the four-character pairing codes, and check the client and permissions. Enter an account name, or choose **Reauthorize** for an existing source when offered. Approve and return to the client.
5. Choose **Done** on the success screen, or add another source.

### Add a connection

Click the upper arc of the center ring, then **Add connection**. Choose **Create my relay**, **Paste relay link**, **Use your own address**, **OpenAI Secure Tunnel**, **Claude Code**, or **Claude Desktop**. Configure the chosen method, then finish on **Ready**. From a stacked dialog, choose **Continue with this connection**; standalone setup offers **Done** or **Add a source for it**. Creating a connection does not itself authorize a control source. See [Connections](guides/connections.md) for each method.

### Local clients

Choose **Claude Code** or **Claude Desktop** when adding a source, then select its local connection. If none exists, use **Add connection** to install it. ARC preserves other configuration entries. Restart Claude after installation. Local connections do not need network configuration or pairing-code approval; source setup waits for the client to connect.

### Manage sources and connections

**Platforms** lists supported platform families and their authorized connector instances. Each card shows the information received during authorization and its timestamps, with rename and remove actions. Removal revokes that connector while retaining its history. The center ring’s upper arc opens device connections for address copying, editing, and removal. Local Agents remain separate.

To change a source's connection, select the target in ARC first. In the client, delete the old ARC connector and add it again with the new address; editing the URL also works where supported. Return to ARC, compare the code, check **Claim as <account name>**, and approve the switch. Name, history and notification settings stay; the old grant is revoked after the new authorization completes.

Relay owners manage invite links, devices and deletion under **Settings → Extras → Relay hosting**. Joined relays have **Leave relay** in Connection detail. Only join a host you trust: the deployer can technically inspect relayed traffic in Cloudflare.

### Dispatch and receive a notification

Open a Claude Code cloud session on claude.ai and send this prompt. Claude can read its own session ID from its environment, for example the `cse_…` value in `CLAUDE_CODE_REMOTE_SDK_URL`:

> Through ARC, create a Codex task that uses no tools, reads no files, and only replies ARC_LOOP_OK. Use a fresh requestId and set notify to {channel: "claude-session", target: your own Claude Code cloud session ID or URL}. Read the receipt and retain threadId and turnId, then end your turn. When the completion notification wakes this session, read the result and confirm it matches.

If Claude cannot read its own session ID, paste the cloud session URL or ID instead.

When Codex completes, ARC sends a status notification that wakes the same Claude session to read the result; for real work it can inspect the diff and continue the same task. The [Claude guide](guides/claude.md) covers task prompts, approvals, and the next round.

## Next

- Let a local Agent configure ARC: [Automatic setup](auto-setup.md).
- Understand task ownership and tool access: [Concepts](concepts.md).
- Prefer ChatGPT Chat: [ChatGPT guide](guides/chatgpt.md).
- Use Windows, Homebrew, or Linux: [Installation](installation.md).

## Check permissions and readiness

Before remote use, open ARC **Permissions & readiness** locally and choose **Check again**. Use **Grant access** where needed. Returning from System Settings refreshes the page.

Accessibility enables screen tree / press / show / key / raise. Screen recording enables capture and windows titles; macOS may require reopening ARC. Use Full Disk Access for file tools: projects in Documents, Desktop, Downloads, external disks or network volumes can otherwise prompt or fail. Core uses a read-only heuristic with granted / missing / unknown results; unknown is not permission. command checks FDA through its executor only when cwd is in a protected location.

Notification permission is checked in ARC Desktop for closed-loop fallback delivery; without Desktop only a log is recorded. Login readiness checks registration and disabled state. Codex, Claude and ingress verification appear on the same page. Inapplicable Windows/Linux permissions do not require action.

### Why does a remote tool return PERMISSION_REQUIRED?

Tools never request system consent. The error includes permissionId; use the local permissions page and retry. A terminal's grants do not establish permissions for Core, screen helper or the Codex executor. The FDA heuristic does not guarantee access to every volume.

For the bundled Desktop launch chain, grant Full Disk Access to ARC App: Core and its Codex app-server children inherit that responsible application. A standalone Core launched by a terminal can instead inherit that terminal's identity; its probe does not prove the App is ready.

## Limits

Keep the computer awake, online, and ARC running. Automatic follow-ups target a Claude Code cloud session; ordinary Claude chat URLs cannot receive them. Complete initial OAuth consent on the computer running ARC before leaving it. See [FAQ](faq.md) if the connector or notification fails.
