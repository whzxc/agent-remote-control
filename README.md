# Agent Remote Control (ARC)

**Plan in Claude. Let local Codex execute. Close the loop without relaying messages yourself.**

**English** | [简体中文](README.zh-CN.md)

![ARC home: Claude and ChatGPT connected to local Agents](docs/images/home-overview.png)

```text
Control sources              Your computer                   Agents
Claude -- HTTPS + OAuth --+                               +-- Codex
                          +-- ARC -- live project facts --+
ChatGPT - Secure Tunnel --+                               +-- Pi / ACP

Codex turn ends -> ARC -> bound Claude Code cloud session
```

## Claude + Codex: the Loop

Discuss and plan in a Claude Code session on claude.ai, accessible from the web, phone, or desktop app. Through ARC, Claude reads current files, Git changes, and Codex tasks, then sends a concrete job to Codex on your computer. After dispatching, Claude can end its turn; when Codex finishes, ARC’s notification wakes the same session to review the changes and continue, while you are away from the keyboard.

Connect Claude through HTTPS + OAuth. Automatic follow-ups additionally need the initiating Claude Code cloud session ID and a signed-in local Claude Code CLI. [Set up the Loop](docs/guides/claude.md).

## ChatGPT Chat + Codex

GPT-6 Astra Pro is available in ChatGPT Chat mode, but not in Codex. ARC connects them: Chat handles deep reasoning, and Codex executes. Use a ChatGPT Pro, Business, or Enterprise account with that option enabled. OpenAI Secure Tunnel is the default connection. [Connect ChatGPT](docs/guides/chatgpt.md).

## Start in three steps

1. **Install.** Download the macOS app from [Releases](https://github.com/whzxc/agent-remote-control/releases/latest), move it to Applications, and sign in to Codex. [Installation](docs/installation.md).
2. **Connect Claude.** Add Claude in ARC, choose HTTPS + OAuth, then add the MCP URL as a custom connector in Claude. Approve the request in ARC.
3. **Send your first task.** Ask Claude: “Use ARC to ask Codex to reply ARC_LOOP_OK without reading files or using tools. Set notifyClaudeSession to your own Claude Code cloud session. End your turn after dispatching; when notified, read the result.” If Claude cannot read its session ID, paste the cloud session URL or ID instead. [Step-by-step guide](docs/getting-started.md).

Prefer local Codex to configure it? Send this prompt:

> Read https://github.com/whzxc/agent-remote-control/blob/main/docs/auto-setup.md and follow the Codex → Claude setup. Inspect the installed app's `cli help` and `cli guide`, preserve existing connections, and help me complete authorization and a harmless first task.

## Documentation

- **Start:** [Getting started](docs/getting-started.md) · [Concepts](docs/concepts.md) · [Automatic setup](docs/auto-setup.md)
- **Connect:** [Claude](docs/guides/claude.md) · [ChatGPT](docs/guides/chatgpt.md) · [Other clients](docs/guides/other-clients.md) · [HTTPS providers](docs/guides/connections.md)
- **Use:** [FAQ](docs/faq.md) · [Install, update, uninstall](docs/installation.md) · [Why ARC](docs/story.md)
- **Reference (English):** [Tools](docs/reference/tools.md) · [Agents](docs/reference/agents.md) · [CLI](docs/reference/cli.md) · [OAuth](docs/reference/oauth.md) · [Subscriptions](docs/reference/subscriptions.md) · [Linux](docs/reference/linux.md)
- **Contribute (中文):** [Development](docs/dev/development.md) · [Architecture](docs/dev/architecture.md) · [UI](docs/dev/ui.md) · [Releases](docs/dev/release.md)

Also supports Notion, Slack, Cursor, GitHub Copilot, Raycast, Microsoft Copilot, Grok and custom MCP clients; Pi, OpenCode and other ACP Agents run alongside Codex.

Local ChatGPT Desktop panels live in the independent [Usage](https://github.com/whzxc/chatgpt-usage-plugin) and [Kanban](https://github.com/whzxc/chatgpt-kanban-plugin) plugin repositories.

## License

[MIT](LICENSE).
