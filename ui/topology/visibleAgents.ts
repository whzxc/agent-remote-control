import type { Agent } from '../state/agents';

export function visibleAgents(ordered: readonly Agent[], max: number, selected?: string): Agent[] {
  const limit = Number.isInteger(max) && max > 0 ? max : 4;
  return ordered.filter(agent => agent.installed && agent.enabled === true)
    .filter((agent, index) => index < limit || agent.agent === selected);
}
