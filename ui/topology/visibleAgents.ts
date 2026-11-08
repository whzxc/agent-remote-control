import type { Agent } from '../state/agents';

export function visibleAgents(ordered: readonly Agent[], max: number, selected?: string): Agent[] {
  const limit = [4, 6, 8, 10].includes(max) ? max : 4;
  return ordered.filter(agent => agent.installed && agent.enabled === true)
    .filter((agent, index) => index < limit || agent.agent === selected);
}
