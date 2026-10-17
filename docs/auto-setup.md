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

## Where the Agent waits for you

- **Choices:** Claude or ChatGPT, address type, and any optional steps. The Agent explains the options and marks the recommendation.
- **Login and authorization:** sign in, approve connection access, and grant local permissions yourself.
- **Fixed Cloudflare address:** choose Cloudflare and sign in to select your hosted domain. ARC creates or reuses the tunnel and binds the address; no token copying is needed.
- **Other credentials:** the Agent clicks the provider’s Copy button and ARC receives and clears the clipboard. If there is no Copy button, copy it yourself; ARC’s form remains a fallback. Never send credentials in chat.
- **Remote test:** the local Agent prepares a prompt; paste it into your Claude Code cloud session or ChatGPT conversation. ARC verifies the remote connection and first task before showing completion.

The Agent waits for ARC’s completion signals. Keep its conversation open; the App shows the current step and actions that need your attention. **Manual setup** remains available from the entry screen.

## Limits

ChatGPT setup requires OpenAI Platform organization permissions and ChatGPT developer mode. If Claude Code is missing, the Agent installs it using Anthropic’s official installer; ARC opens a terminal for you to sign in. Claude’s automatic follow-ups require a signed-in local Claude Code CLI and a Claude Code cloud session; skipping Claude Code omits notification verification. A successful local command or screenshot alone does not prove the remote connection works. Keep the computer awake, online, and ARC running during setup.
