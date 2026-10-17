# Claude Code installation and sign-in

If `setup next` supplies `installCommand`, run it using the official
[installation instructions](https://code.claude.com/docs/en/setup):
macOS/Linux `curl -fsSL https://claude.ai/install.sh | bash`; Windows PowerShell
`irm https://claude.ai/install.ps1 | iex`. Then apply `claude-code-ready` with `{}`.
ARC opens a terminal running `claude auth login`. On headless Linux, the user
runs that command in their own interactive terminal.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Help locate the
  login browser tab and continue on signed-in pages under the protocol. If the CLI
  asks for a code, the user enters it directly in the terminal.
- **Computer use / ARC screen:** Navigate to the login terminal/browser, then
  follow the same protocol. Do not capture authorization codes.
- **Neither:** Link the official instructions and say “Complete Claude Code
  sign-in in the terminal and browser ARC opened.”

Run `cli setup wait` for authenticated status. Skipping remains a user choice,
not an installation fallback: it disables cloud-session completion notifications.
