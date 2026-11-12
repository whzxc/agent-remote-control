export const permissionCopy = {
  "permissionsTitle": "Permissions & readiness",
  "permissionsRefresh": "Check again",
  "permissionsSystem": "System permissions",
  "permissionsEnvironment": "Environment",
  "permissionsAppHint": "Enable the following permissions for Agent Remote Control in System Settings.",
  "permissionState.unknown": "Unknown",
  "permissionsGrant": "Grant access",
  "permissionsEnable": "Enable",
  "permissionsInstructions": "View instructions"
};
export const permissionRows = [
  {
    "id": "accessibility",
    "title": "Accessibility",
    "description": "Let your controller read and operate apps with clicks and keystrokes.",
    "icon": "accessibility",
    "system": true
  },
  {
    "id": "screen-recording",
    "title": "Screen recording",
    "description": "Let your controller capture screens and windows. Reopen ARC after granting access.",
    "icon": "monitor",
    "system": true
  },
  {
    "id": "full-disk-access",
    "title": "Full Disk Access",
    "description": "Needed for projects in Documents, Desktop, Downloads, external disks or network volumes to avoid interruptions.",
    "icon": "hard-drive",
    "system": true
  },
  {
    "id": "notifications",
    "title": "Notifications",
    "description": "Receive a system notification when a Claude loop notification cannot be delivered.",
    "icon": "bell",
    "system": true
  },
  {
    "id": "login-start",
    "title": "Start at login",
    "description": "Connect automatically at sign-in so work can continue while you are away.",
    "icon": "log-in",
    "system": true
  },
  {
    "id": "codex",
    "title": "Codex",
    "description": "Codex Desktop is installed and signed in.",
    "icon": "monitor",
    "system": false
  },
  {
    "id": "claude-code",
    "title": "Claude Code CLI",
    "description": "Loop notifications need a locally installed and signed-in Claude Code CLI.",
    "icon": "terminal",
    "system": false
  }
];
