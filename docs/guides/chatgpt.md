# ChatGPT Chat + local Codex

**English** | [简体中文](../zh-CN/guides/chatgpt.md)

Use Chat mode to reason through a problem with GPT-6 Astra Pro, then let Codex implement the plan on your computer. ARC lets Chat read current project facts before it decides what to delegate.

Call `guide` first for this connection’s workflow, enabled ops, and examples. Use `guide({"op":"codex_create"})` for the full schema. Invoke operations through `query({"op":"…","args":{…}})` or `act({"op":"…","args":{…}})`; reread `guide` when a result’s `arcVersion` changes.

## Choose the Chat model

Use a ChatGPT Pro, Business, or Enterprise account where the Chat Pro option is available. Select GPT-6 Astra Pro (also presented as GPT-6 Pro, powered by Astra) in Chat's model/thinking controls. Confirm the option in your account before making it part of your workflow.

Codex offers the ordinary `gpt-6-astra` model; its model list does not expose a separate Astra Pro option. Choose the reasoning model in Chat and the execution model in Codex independently. ARC forwards the task's model settings; it does not add Chat models to Codex. See OpenAI's [model guide](https://learn.chatgpt.com/docs/models) for current Codex choices.

## Connect with OpenAI Secure Tunnel

1. Install ARC and sign in to Codex Desktop.
2. Follow the official [Secure MCP Tunnel setup](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) to obtain a Tunnel ID and runtime API key. Enter them directly in ARC's **ChatGPT** connection form.
3. Save and connect. ARC prepares and manages the official Tunnel Client, reusing a qualifying cached version before downloading the supported official release with SHA256 verification. Startup does not depend on the anonymous GitHub API.
4. Enable **Developer Mode** in ChatGPT where available. Open [Plugins](https://chatgpt.com/plugins), create a developer-mode connection, choose **Tunnel**, and select the same tunnel. Follow the current [connection instructions](https://developers.openai.com/plugins/deploy/connect-chatgpt) if the UI labels differ.
5. Enable ARC in the Chat conversation. Run the verification prompt shown by ARC; it calls `act connector_verify` with that ingress's code.

The runtime API key comes from [Platform Runtime API keys](https://platform.openai.com/settings/organization/api-keys), with Tunnels Read + Use for the target tunnel. Tunnel creation requires Read + Manage. ARC requires observed control-plane authentication before reporting readiness; 401/403 returns Agent setup to the key step.

Tunnel creation/use permissions belong to the OpenAI Platform organization. Developer Mode access belongs to the ChatGPT workspace. Ask the relevant administrator for the missing permission. Credentials belong in the local form or protected CLI stdin, not in a conversation.

## Reason in Chat, execute in Codex

> Read this project's current files, Git state, and recent Codex tasks through ARC. Compare the options and propose a plan with acceptance criteria. Once we agree, dispatch it to Codex with a fresh requestId and preserve the returned task IDs.

Use `act codex_create` for a new task, `act codex_send` for another round, and `query codex_wait` for progress. After a timeout, continue with the same threadId/turnId and previous snapshotHash as expectedHash. Ask Chat to review `query codex_changes` and the final task output before deciding what comes next.

For setup by a local Agent, use [Automatic setup](../auto-setup.md). On an actual Tunnel access failure, Agent setup offers HTTPS + OAuth with a Cloudflare fixed address or a temporary address; it keeps the ChatGPT goal and reuses the existing OAuth steps. See [Connections](connections.md). HTTPS does not bypass workspace restrictions on custom MCP connections.

## Limits

Model options and Developer Mode depend on your account, workspace policy, and client rollout. Keep the computer awake and ARC connected. Ordinary Chat does not receive ARC's Claude cloud-session notifications; return to the conversation and ask for progress, or keep waiting while the turn is active. Secure Tunnel connects private MCP servers; publishing a public plugin uses a separate distribution flow.
