# Other fixed-address providers

Configure the provider and non-secret fixed hostname using `cli ingress update`
before opening the ARC fallback form. Use the provider's existing dashboard
connection where possible. Never read its credential value.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `credentialUrl`.
  Hand login and authorization to the user. Click the official credential or
  installation-command **Copy** button without reading the value, then apply
  `address-secret` with `{"source":"clipboard"}`.
- **Computer use / ARC screen:** Navigate to the copy control only while the
  credential is hidden. Click Copy, then apply the same clipboard action. Do not
  take screenshots of a revealed credential.
- **Neither:** Give `credentialUrl` and ask the user to copy the credential;
  then apply the clipboard action. If no official copy button exists, ask the
  user to copy manually instead of revealing or transcribing the value yourself.

Core extracts the credential, clears the clipboard, and returns only its saved
flag. Never read the clipboard, browser DOM, or screenshots for secrets. Use
`openUrl` for direct entry in ARC only as a fallback. Then run `cli setup wait`.
