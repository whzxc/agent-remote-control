# Let a local Agent set up ARC

**English** | [简体中文](zh-CN/auto-setup.md)

On a fresh Mac with a signed-in Codex or Claude control-source client, start
with this instruction. This skill does not install or sign in to executable
Antigravity or Pi Agents; manage those separately in Agent management.

> Set up Agent Remote Control on this computer. Follow https://raw.githubusercontent.com/whzxc/agent-remote-control/main/skills/arc-setup/SKILL.md

The skill detects ARC, runs the release installer when needed, installs its setup
skill for your Agent, and continues through local mode or shared-relay setup. The macOS
installer checks the App tarball’s checksum, installs and opens ARC, and waits
for Core. No DMG mounting or command assembly is needed.

Remote verification uses `act({"op":"connector_verify","args":{"code":"<code>"}})`. Task acceptance starts with `guide`, then dispatches through `act` and waits/reads through `query`. If cached guide parameters reject op, use `query({"op":"guide","args":{"op":"codex_create"}})`. The MCP tools stay fixed at guide / query / act; connection levels apply to ops.

## Continue in the App

Choose local mode, or create/join a shared relay and add a control source. See
[Getting started](getting-started.md). ChatGPT and Claude use the same remote link
and local pairing-code approval flow.

Open **Remote link → Connections → Add connection** to configure **Own address** or **OpenAI Secure Tunnel**. Then select that connection in **Add control source**. The connection-selection step also offers an **Add connection** shortcut.
You assist with login, passwords, 2FA, payment, or policy-required approvals.

## Limits

The shared-relay deployer only sees a computer list in ARC, but can technically
inspect relayed traffic in Cloudflare. Only join someone you trust. Your account
and workspace must permit the client connection. A grant proves authorization;
a real remote tool response proves connectivity. A local command does not replace
that evidence. Keep the computer awake and ARC running. Automatic follow-ups also
need a signed-in local Claude Code and the initiating cloud session.
