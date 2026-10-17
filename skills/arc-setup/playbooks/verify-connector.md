# Verify the remote connector

Use the fresh `onboarding.verificationPrompt` returned by next.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`, select
  the ARC connector/plugin in a conversation, and send the verification prompt.
  Continue through consent using the protocol and its safety-policy exceptions.
- **Computer use / ARC screen only:** Navigate a conversation and select ARC from
  screenshots, then enter the same prompt using the protocol.
- **Neither:** Give `openUrl` and the prompt, with: “Select ARC in this conversation
  and send this verification prompt.”

Run `cli setup wait`. Only the new remote challenge response advances setup;
local probe success and conversation screenshots are insufficient.
