# Test a task from the remote conversation

You are the **local setup agent**. Do not create the test task locally. Generate a
ready-to-paste prompt from `onboarding.executionPrompt`, translating it if needed
while preserving its task, requestId, wait, and output requirements.

For `claude-loop`, the user must send it from a **Claude Code cloud session**,
not this local CLI session or ordinary Claude chat. Append: “Call ARC through its
connector. Set notifyClaudeSession to this Claude Code cloud session's actual
session ID or URL. If you cannot identify it, ask me for it; never invent it.”
If findings say Claude Code was explicitly skipped, omit notification binding;
explain that only task completion will be checked.

For `chatgpt-chat`, the user sends it in a **ChatGPT conversation with ARC enabled**.
Append: “Call ARC through its plugin in this conversation.” No Claude session is
needed. The task must only reply `ARC_ONBOARDING_OK`, without tools or file access.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** For Claude open
  `https://claude.ai/` and guide the user to Code and their cloud session; for
  ChatGPT open `openUrl` and locate the conversation. Give the generated prompt
  to the user to paste and send. Leave login and authorization to them.
- **Computer use / ARC screen only:** Locate that remote session via screenshots,
  then give the prompt for the user to paste and send.
- **Neither:** Give the relevant link and prompt: “Paste and send this in your
  Claude Code cloud session / ChatGPT conversation with ARC enabled.”

Then run `cli setup wait`, continuing across timeouts. Never create a replacement
local task. ARC checks the selected ingress's task and, for the Claude loop,
notification delivery or an explicit failure finding. Report findings as returned.
