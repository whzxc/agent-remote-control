export const ringCopy = {
  remote: {
    status: { healthy: "Remote connections healthy", unhealthy: "Remote connections unavailable" },
    healthy: { icon: "network", label: "View connections" },
    unhealthy: { icon: "rotate-cw", label: "Recover remote connections" },
  },
  core: {
    status: { healthy: "ARC Core healthy", unhealthy: "ARC Core unavailable" },
    healthy: { icon: "power", label: "Stop Core" },
    unhealthy: { icon: "rotate-cw", label: "Recover Core" },
  },
  recovery: {
    remote: {
      title: "Remote connection recovery",
      reason: "The remote tunnel is unavailable.",
      impact: "Restarting this connection briefly interrupts its remote access.",
      secondary: "Restart connection",
      primary: "Retry",
    },
    core: {
      title: "Core recovery",
      reason: "ARC Core did not respond.",
      impact: "Restarting Core can interrupt active ARC operations and remote access.",
      secondary: "Restart Core",
      primary: "Retry",
    },
    "core-stopped": {
      title: "Core recovery",
      reason: "ARC Core is stopped.",
      impact: undefined,
      secondary: undefined,
      primary: "Start Core",
    },
    blocked: {
      title: "Remote connection recovery",
      reason: "Remote access needs ARC Core to be running.",
      impact: undefined,
      secondary: undefined,
      primary: "Open Core recovery",
    },
  },
};

export const markForms = [
  { name: "topology-mark", note: "Both arcs healthy. Hover or keyboard focus reveals the arc actions." },
  { name: "topology-mark-remote-hover", revealed: "remote", note: "View connections, including when none are configured." },
  { name: "topology-mark-core-hover", revealed: "core", note: "Stop Core." },
  {
    name: "topology-mark-remote-unhealthy",
    remote: "unhealthy",
    revealed: "remote",
    note: "An expected remote transport is unavailable. View connections and Recover remote connections remain available.",
  },
  {
    name: "topology-mark-core-unhealthy",
    core: "unhealthy",
    revealed: "core",
    note: "Core is unavailable and no remote connection is expected to run.",
  },
  {
    name: "topology-mark-both-unhealthy",
    remote: "unhealthy",
    core: "unhealthy",
    note: "Both checks failed. The remote recovery panel explains the Core prerequisite when it blocks remote access.",
  },
] as const;

export const recoveryForms = [
  { form: "remote", note: "Restart targets the affected ARC transport. Core stays running." },
  { form: "core", note: "Desktop owns Core recovery." },
  { form: "core-stopped", note: "An explicit stop persists until Start Core." },
  { form: "blocked", note: "The remote action routes to Core recovery when Core is unavailable." },
] as const;
