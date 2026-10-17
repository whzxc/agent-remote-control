# Let a local Agent set up ARC

**English** | [简体中文](zh-CN/auto-setup.md)

On a fresh Mac with a signed-in local Agent, start with this instruction:

> Set up Agent Remote Control on this computer. Follow https://raw.githubusercontent.com/whzxc/agent-remote-control/main/skills/arc-setup/SKILL.md

The skill detects ARC, runs the release installer when needed, installs its setup
skill for your Agent, and continues through the local setup protocol. The macOS
installer checks the App tarball’s checksum, installs and opens ARC, and waits
for Core. No DMG mounting or command assembly is needed.

## Continue in the App

If ARC is already installed, click **Add control source**, choose **Claude**
(recommended) or **ChatGPT**, then **Send to Codex**. Use **Open Codex task** to
continue the conversation, or **Continue setup** on the home screen to return later.

If Codex is installed but signed out, click **Sign in to Codex** first. If it is
missing, use the download link or copy the setup prompt to another local Agent.
The App’s copied prompt includes the current instance’s CLI path and state directory.
See [Installation](installation.md) for other platforms and manual installation,
and the [CLI reference](reference/cli.md) for executable paths.

## What the Agent does, and when it needs you

After you choose a goal, the Agent explains the resources and local-tool access
and asks for one scope confirmation, reusing an explicit confirmation already given.
Within that scope, the Agent operates already signed-in setup pages: it creates/reuses tunnels,
creates runtime keys, completes risk acknowledgments and connector creation, and
approves the matching ARC OAuth request through the authenticated local CLI.
After that confirmation, it pauses for missing login, CAPTCHA/challenges, passwords/2FA, payment, or its
own safety-policy requirements. Choices still appear in the Agent conversation.

For Cloudflare fixed addresses, ARC manages the authorization certificate,
tunnel and DNS. Other credentials use the official Copy button and ARC's
clipboard receiver; only a successful save clears the clipboard. If no copy
control or usable UI tool exists, the Agent gives one manual instruction.
Never send credentials in chat. Remote tests run in a Claude Code cloud session
or ChatGPT conversation; a locally created task cannot prove that connection.

The Agent waits for ARC’s completion signals. Keep its conversation open; the App shows the current step and actions that need your attention. **Manual setup** remains available from the entry screen.

## Limits

ChatGPT setup tries OpenAI Secure Tunnel directly. An explicit Platform denial or rejected runtime key offers retry or HTTPS + OAuth, using a Cloudflare fixed address or a temporary address. HTTPS avoids Platform Tunnel permissions; it cannot bypass ChatGPT workspace restrictions on custom MCP servers. If Claude Code is missing, the Agent installs it using Anthropic’s official installer; ARC opens a terminal for you to sign in. Claude’s automatic follow-ups require a signed-in local Claude Code CLI and a Claude Code cloud session; skipping Claude Code omits notification verification. A successful local command or screenshot alone does not prove the remote connection works. Keep the computer awake, online, and ARC running during setup.
