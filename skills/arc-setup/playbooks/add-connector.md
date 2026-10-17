# Add Claude connector

Use `onboarding.url` from next; never substitute a local probe URL.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`.
  In Customize → Connectors choose Add → Custom → Web. Fill a name and the
  ingress URL. For ARC OAuth choose Register automatically when authentication
  options appear. Hand login and authorization/consent to the user.
- **Computer use / ARC screen only:** Navigate the same controls from screenshots;
  stop for the user's login or consent and avoid credential screens.
- **Neither:** Give `openUrl` and say: “In Customize → Connectors, add a custom Web
  connector using this ARC URL and automatic OAuth registration.”

Run `cli setup wait`. An accepted registration/authorize request advances setup;
connector screenshots do not prove completion.

[Claude connector guide](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
