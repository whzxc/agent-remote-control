# Cloudflare sign-in

Apply `cloudflare-login` with `{}` once to start ARC's managed login. Re-read
`setup next` for the captured `openUrl`. ARC keeps the certificate in its state
directory and handles tunnel creation, DNS, and local credentials afterward.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl`, then
  hand over login, domain selection, and authorization to the user.
- **Computer use / ARC screen:** Navigate to the opened authorization page;
  let the user sign in and select the hosted domain.
- **Neither:** Give `openUrl` and say “Sign in and select your Cloudflare domain.”

Run `cli setup wait`. If login expires, apply again. No token copying is needed.
Tell the user the resulting address when setup reports it. Do not create tunnels
or change DNS separately in the dashboard; ARC owns those operations.
