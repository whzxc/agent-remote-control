# Your first Claude + Codex loop

**English** | [简体中文](zh-CN/getting-started.md)

## 1. Install on macOS

Download the Apple Silicon DMG from [Releases](https://github.com/whzxc/agent-remote-control/releases/latest). Drag **Agent Remote Control** into Applications, eject the DMG, and open the app. Install Codex Desktop and sign in. For automatic follow-ups, also install and sign in to Claude Code CLI.

If macOS blocks a verified download, use **System Settings → Privacy & Security → Open Anyway**. For a “damaged” warning, remove quarantine from this app:

```sh
xattr -rd com.apple.quarantine "/Applications/Agent Remote Control.app"
```

## 2. Connect Claude

1. Click **Add control source** on the ARC home screen and choose **Claude**.
2. Choose **HTTPS**, **OAuth**, and a provider. Cloudflare Temporary works for a first try; use a fixed address for regular use.
3. Save, connect, and copy the displayed MCP URL.
4. In Claude's connector settings, add a custom connector with that URL. Start its authorization flow.
5. Keep the authorization page open. Choose **Open ARC**, check the request in ARC, and allow it. Return to Claude and enable the connector for the conversation.
6. Copy the connection's verification prompt and ask Claude to run it. It calls `connector_verify` through the connection you just added.

## 3. Dispatch and receive a notification

Open a Claude Code cloud session on claude.ai and send this prompt. Claude can read its own session ID from its environment, for example the `cse_…` value in `CLAUDE_CODE_REMOTE_SDK_URL`:

> Through ARC, create a Codex task that uses no tools, reads no files, and only replies ARC_LOOP_OK. Use a fresh requestId and set notifyClaudeSession to your own Claude Code cloud session. Read the receipt and retain threadId and turnId, then end your turn. When the completion notification wakes this session, read the result and confirm it matches.

If Claude cannot read its own session ID, paste the cloud session URL or ID instead.

When Codex completes, ARC sends a status notification that wakes the same Claude session to read the result; for real work it can inspect the diff and continue the same task. The [Claude guide](guides/claude.md) covers task prompts, approvals, and the next round.

## Next

- Let a local Agent configure ARC: [Automatic setup](auto-setup.md).
- Understand task ownership and tool access: [Concepts](concepts.md).
- Prefer ChatGPT Chat: [ChatGPT guide](guides/chatgpt.md).
- Use Windows, Homebrew, or Linux: [Installation](installation.md).

## Limits

Keep the computer awake, online, and ARC running. Automatic follow-ups target a Claude Code cloud session; ordinary Claude chat URLs cannot receive them. Complete initial OAuth consent on the computer running ARC before leaving it. See [FAQ](faq.md) if the connector or notification fails.
