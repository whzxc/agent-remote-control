import type { ProviderAccount } from '../../../types';
import { name } from '../../../state/agents';
import type { WireState } from '../../../topology/render';
import GraphNode from '../../GraphNode';
import { AgentQuotaIcon } from '../../../subscriptions/QuotaRing';
export function AgentAccountNode({ account, agent, platformLabel = name({ agent }), suffix, candidateLabel, state, selected, onOpen }: { account: Pick<ProviderAccount, 'alias' | 'quota'>; agent: string; platformLabel?: string; suffix?: string; candidateLabel?: string; state: WireState; selected?: boolean; onOpen: () => void }) {
  const title = `${platformLabel} · ${account.alias}`, label = `${title}${suffix ? ` · ${suffix}` : ''}`;
  return <GraphNode label={label} state={state} highlighted={selected} onOpen={onOpen}><AgentQuotaIcon agent={agent} quota={account.quota ?? null} /><span className={`graph-node-name${suffix ? ' topology-unidentified-label' : ''}`}>{candidateLabel ?? label}</span></GraphNode>;
}
