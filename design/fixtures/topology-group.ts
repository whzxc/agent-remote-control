import type { TopologyGroupMember, TopologyGroupProps } from "../modules/topology-group";

export const idleCodexAccounts: readonly TopologyGroupMember[] = [
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "low" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "out" },
  { brand: "codex", quota: "ok" },
  { brand: "codex", quota: "low" },
  { brand: "codex", quota: "ok" },
];
export const idleAgents: readonly TopologyGroupMember[] = [
  { brand: "claude-code" },
  { brand: "opencode" },
  { brand: "deepseek" },
  { brand: "cursor" },
];
export const idleSources: readonly TopologyGroupMember[] = [
  { brand: "anthropic" },
  { brand: "google" },
  { brand: "xai" },
];

export const forms: readonly (TopologyGroupProps & { name: string })[] = [
  { name: "pool", label: "8 idle accounts", members: idleCodexAccounts },
  { name: "mixed", label: "4 idle Agents", members: idleAgents },
  { name: "rail-source", label: "3 idle", members: idleSources, layout: "source" },
  { name: "rail-agent", label: "4 idle", members: idleAgents, layout: "agent" },
  { name: "unlabeled", label: "4 idle Agents", members: idleAgents, hideLabel: true },
];
