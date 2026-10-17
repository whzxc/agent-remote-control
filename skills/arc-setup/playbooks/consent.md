# Approve ARC access

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl` to
  ARC's pending OAuth request. Explain the requested access; the user presses
  Approve/Allow. If only the connection editor opens, ask the user to finish
  Connect in the remote connector so ARC receives the authorization request.
- **Computer use / ARC screen only:** Locate the pending request from a screenshot
  and point out the approval control; the user clicks it.
- **Neither:** Give `openUrl` and say: “Review this connector's access request in
  ARC and approve it if you agree.”

Never submit an OAuth decision through CLI on the user's behalf.
Run `cli setup wait`; ARC checks for a grant.
