import type { ReactNode } from 'react';
import type { Agent } from '../../../state/agents';
import type { ProviderAccount } from '../../../types';
import type { WireState } from '../../../topology/render';
import { name } from '../../../state/agents';
import { AgentQuotaIcon } from '../../../subscriptions/QuotaRing';
import GraphNode from '../../GraphNode';
export function AgentPlatformNode({ agent, label, state, quota, selected, onOpen, children }: { agent: Agent; label?: string; state: WireState; quota?: ProviderAccount['quota'] | null; selected?: boolean; onOpen: () => void; children?: ReactNode }) {
  return <GraphNode label={label ?? name(agent)} state={state} highlighted={selected} onOpen={onOpen}><AgentQuotaIcon agent={agent.agent} quota={quota} /><span className="graph-node-name">{name(agent)}</span>{children}</GraphNode>;
}
