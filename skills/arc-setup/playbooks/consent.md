# Approve ARC access

Read `cli ingress oauth list <ingressId>` and the pending request with
`cli ingress oauth request <ingressId> <request-id>`. Check its client, callback,
and resource belong to the connector being configured. Use authenticated local
`cli ingress oauth decision <ingressId> --stdin` with
`{"id":"<request-id>","allow":true}` for this delegated setup. Follow the
protocol's safety-policy exceptions; do not approve unrelated pending requests.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Return to the
  remote connector and complete Connect/Allow. If no request is pending yet,
  initiate Connect there, then read it again through CLI.
- **Computer use / ARC screen:** Navigate the same controls, or `openUrl` in ARC.
- **Neither:** The CLI decision still works. If browser completion is needed,
  give the remote connector link and ask the user to finish connecting.

Run `cli setup wait`; ARC checks for a grant.
