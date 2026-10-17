# Permissions

Repeat `explain`. Full Disk Access and applicable Codex command Full Disk Access
are required. Accessibility and screen recording unlock screen tools; notifications
provide notification fallback. These optional permissions do not block setup.

- **Browser tools (Claude in Chrome / Codex browser / IAB):** Open `openUrl` in ARC
  Settings → Permissions & readiness. Point out the required disk-access actions;
  the user grants permissions in system settings. With no native-app control,
  guide the user using ARC's labels.
- **Computer use / ARC screen only:** Locate those actions via screenshots and
  navigate to system settings; the user changes permission toggles or approves
  system prompts. Do not rely on screen tools being available yet.
- **Neither:** Give `openUrl` and say: “Grant the required Full Disk Access entries
  in ARC's permissions page; enable optional screen/notification access if wanted.”

Run `cli setup wait`. If the user explicitly chooses skip, submit that option
through apply. Never enable optional permissions or skip on their behalf.
