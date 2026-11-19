import type { TopologyGroupMember, TopologyGroupProps } from '../modules/homepage-scene';

export const idleSourceAccounts: readonly TopologyGroupMember[] = [
  { brand: "anthropic", quota: "ok" },
  { brand: "anthropic", quota: "ok" },
  { brand: "anthropic", quota: "low" },
  { brand: "anthropic", quota: "ok" },
  { brand: "anthropic", quota: "out" },
  { brand: "anthropic", quota: "ok" },
  { brand: "anthropic", quota: "low" },
  { brand: "anthropic", quota: "ok" },
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
] as const satisfies readonly TopologyGroupProps[];

export const forms: readonly (TopologyGroupProps & { name: string })[] = [
  { name: "pool", label: "8 idle accounts", members: idleSourceAccounts },
  { name: "mixed", label: "4 idle Agents", members: idleAgents },
  { name: "rail-source", label: "3 idle", members: idleSources, layout: "source" },
  { name: "rail-agent", label: "4 idle", members: idleAgents, layout: "agent" },
  { name: "unlabeled", label: "4 idle Agents", members: idleAgents, hideLabel: true },
];
