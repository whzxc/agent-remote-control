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

export const portraitAccountGroups = [
  {
    label: "Anthropic · 2 idle accounts",
    members: [{ brand: "anthropic", quota: "unknown" }, { brand: "anthropic", quota: "unknown" }],
  },
  {
    label: "Codex · 11 idle accounts",
    layout: "agent",
    members: [
      { brand: "codex", quota: "out" },
      ...Array.from({ length: 10 }, () => ({ brand: "codex", quota: "ok" }) as const),
    ],
  },
  {
    label: "Claude Code · 2 idle accounts",
    layout: "agent",
    members: [{ brand: "claude-code", quota: "low" }, { brand: "claude-code", quota: "ok" }],
  },
] as const satisfies readonly TopologyGroupProps[];

export const forms: readonly (TopologyGroupProps & { name: string })[] = [
  { name: "pool", label: "8 idle accounts", members: idleCodexAccounts },
  { name: "mixed", label: "4 idle Agents", members: idleAgents },
  { name: "rail-source", label: "3 idle", members: idleSources, layout: "source" },
  { name: "rail-agent", label: "4 idle", members: idleAgents, layout: "agent" },
  { name: "unlabeled", label: "4 idle Agents", members: idleAgents, hideLabel: true },
];
