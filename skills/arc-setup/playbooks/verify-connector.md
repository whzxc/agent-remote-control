# Verify the remote connector

Use the fresh `onboarding.verificationPrompt` returned by next.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`, select
  the ARC connector/plugin in a conversation, and send the verification prompt.
  Hand login and any tool authorization/consent to the user.
- **Computer use / ARC screen only:** Navigate a conversation and select ARC from
  screenshots, then enter the same prompt; the user handles authorization.
- **Neither:** Give `openUrl` and the prompt, with: “Select ARC in this conversation
  and send this verification prompt.”

Run `cli setup wait`. Only the new remote challenge response advances setup;
local probe success and conversation screenshots are insufficient.
