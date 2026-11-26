# Test a Task from the Remote Conversation

ARC exposes `guide`, `query`, and `act` (`act({"op":"codex_create","args":{...},"requestId":"<UUID>"})`, `query` for wait/read/review, `notify` inside `args`; refresh `guide` when `arcVersion` changes, or `query({"op":"guide","args":{"op":"codex_create"}})` if stale).

Do **not** create the test task locally. Generate a ready-to-paste prompt from `onboarding.executionPrompt` (preserving task, `requestId`, wait, and output requirements):

- **`claude-loop`** (send in a **Claude Code cloud session** on `https://claude.ai/`): append `"Call ARC through its connector. Set notify to {channel: \"claude-session\", target: this Claude Code cloud session's actual session ID or URL}. If you cannot identify it, ask me for it; never invent it."` (omit `notify` and explain completion-only check if Claude Code was skipped).
- **`chatgpt-chat`** (send in a **ChatGPT conversation** with ARC enabled): append `"Call ARC through its plugin in this conversation."` The task must reply only `ARC_ONBOARDING_OK` without tools or file access.

Send via browser tools / screen, or provide the link and prompt to the user if neither is available. Then run `cli setup wait` (continue across timeouts) and report findings as returned.
