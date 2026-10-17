# Sign in to Codex

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl` in ARC,
  or execute this step's `apply` with `{}` to open the existing Codex login flow.
  Continue through an already signed-in authorization page. Follow the protocol
  for missing login, password/2FA, or safety-policy exceptions.
- **Computer use / ARC screen only:** Locate ARC's Codex login action from a
  screenshot and continue with the same protocol.
- **Neither:** Give `openUrl` and say: “Open Codex login in ARC and finish signing
  in with your account.”

Run `cli setup wait`; the authenticated Codex login state is the completion signal.
