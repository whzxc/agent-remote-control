# Let a local Agent set up ARC

**English** | [简体中文](zh-CN/auto-setup.md)

[Install ARC](installation.md) on the computer you want to control, then open the App.

## Send to Codex

Click **Add control source**, choose **Claude** (recommended) or **ChatGPT**, then **Send to Codex**. ARC installs its setup skill, opens a local setup task, and shows progress. Use **Open Codex task** to continue the conversation, or **Continue setup** on the home screen to return later.

If Codex is installed but signed out, click **Sign in to Codex** first. If it is missing, use the download link or copy the setup prompt to another local Agent.

## Use another local Agent

Choose **Copy for another Agent** in ARC, or paste this prompt into your local Codex or Claude Code conversation:

> Help me configure the installed Agent Remote Control on this computer: locate its CLI, run `cli skill install --target codex` (use `--target claude-code` for Claude Code; other Agents can skip installation), read `cli setup playbook protocol`, and follow `cli setup`; ask me to choose and authorize, keep secrets in ARC, and confirm completion with `cli setup wait`.

Other local Agents can read the protocol directly without installing a skill. The [CLI reference](reference/cli.md) lists executable paths. The App’s copied prompt includes the current instance’s CLI path and state directory.

## Where the Agent waits for you

- **Choices:** Claude or ChatGPT, address type, and any optional steps. The Agent explains the options and marks the recommendation.
- **Login and authorization:** sign in, approve connection access, and grant local permissions yourself.
- **Credentials:** paste runtime keys or provider credentials into ARC’s form, never into chat.
- **Remote test:** the local Agent prepares a prompt; paste it into your Claude Code cloud session or ChatGPT conversation. ARC verifies the remote connection and first task before showing completion.

The Agent waits for ARC’s completion signals. Keep its conversation open; the App shows the current step and actions that need your attention. **Manual setup** remains available from the entry screen.

## Limits

ChatGPT setup requires OpenAI Platform organization permissions and ChatGPT developer mode. Claude’s automatic follow-ups require a signed-in local Claude Code CLI and a Claude Code cloud session; skipping Claude Code omits notification verification. A successful local command or screenshot alone does not prove the remote connection works. Keep the computer awake, online, and ARC running during setup.
