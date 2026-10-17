# Fixed-address credentials

Use `credentialUrl` for the selected provider and `openUrl` for this ingress's
ARC editor. The deep link identifies the credential field; if not focused,
tell the user which provider credential field to select.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open the provider's
  credential page and ARC editor. Navigate non-secret setup controls, then hand
  over before login, token revelation or copying. The user pastes the token
  directly into ARC and saves the connection.
- **Computer use / ARC screen only:** Navigate to the provider and ARC editor
  using screenshots, then hand over; do not capture revealed credentials.
- **Neither:** Give both URLs and say: “Obtain this provider's fixed-address
  credential and paste it directly into the matching field in ARC, then save.”

Do not read tokens through browser DOM, clipboard, screenshots, or CLI.
Run `cli setup wait` after the secret is hidden.
