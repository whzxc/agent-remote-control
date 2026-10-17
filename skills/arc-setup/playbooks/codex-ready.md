# Sign in to Codex

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl` in ARC,
  or execute this step's `apply` with `{}` to open the existing Codex login flow.
  Explain where the user signs in. Leave all login and authorization buttons to
  the user; do not read credentials or authentication codes.
- **Computer use / ARC screen only:** Locate ARC's Codex login action from a
  screenshot and point it out. The user completes sign-in privately.
- **Neither:** Give `openUrl` and say: “Open Codex login in ARC and finish signing
  in with your account.”

Run `cli setup wait`; the authenticated Codex login state is the completion signal.
