import { SrcAccountNode } from '../components/objects/src-account';
import { AgentAccountNode } from '../components/objects/agent-account';
import { AgentPlatformNode } from '../components/objects/agent-platform';
import { controlSource } from '../controlSources';
import { accountOwns } from '../accountPresentation';
import type { ProviderAccount } from '../types';
import type { ControlSource } from '../state/types';
import { name, type Agent } from '../state/agents';
import type { Candidate } from './solve';
import type { ReactNode } from 'react';
export interface CandidateView extends Candidate { content: ReactNode }
// Accounts retain the persisted source/platform and per-platform account order.
export function accountViews({ sources, agents, accounts, orders, open }: {
  sources: ControlSource[]; agents: Agent[]; accounts: ProviderAccount[]; orders: Record<string, string[]>;
  open: (side: -1 | 1, platform: string, sourceId?: string, accountId?: string) => void;
}): CandidateView[] {
  const result: CandidateView[] = [], seen = new Set<string>();
  for (const source of sources) {
    const account = accounts.find(a => a.sources.includes(source.id));
    const unidentified = accounts.filter(a => a.alias === 'Unidentified' && a.sources.some(id => sources.some(s => s.id === id && s.product === source.product))).map(a => a.id).sort();
    const suffix = account?.alias === 'Unidentified' ? String(unidentified.indexOf(account.id) + 1) : undefined;
    const local = source.credential.type === 'local';
    const id = JSON.stringify(['source', source.product, account?.id ?? source.id]);
    if (seen.has(id)) continue;
    seen.add(id);
    const platformLabel = controlSource(source.product)?.displayName ?? source.product;
    const accountLabel = `${account?.alias ?? source.label}${suffix ? ` · ${suffix}` : ''}`;
    const multiple = new Set(sources.filter(s => s.product === source.product).map(s => accounts.find(a => a.sources.includes(s.id))?.id ?? s.id)).size > 1;
    const label = multiple ? accountLabel : platformLabel;
    result.push({ id, platform: source.product, platformLabel, accountLabel, accessibleLabel: `${platformLabel} · ${accountLabel}`, side: local ? 'local' : 'cloud', accountId: account?.id,
      sourceIds: account ? sources.filter(s => s.product === source.product && account.sources.includes(s.id)).map(s => s.id) : [source.id],
      label,
      content: <SrcAccountNode product={source.product} account={account} suffix={suffix} candidateLabel={label} sourceLabel={source.label} state={source.state === 'connected' ? 'normal' : 'inactive'}
        onOpen={() => open(-1, source.product, source.id, account?.id)} /> });
  }
  for (const agent of agents) {
    const linked = accounts.filter(a => a.agentProfiles.some(p => p.agent === agent.agent));
    const rank = orders[`1:${agent.agent}`] ?? [];
    linked.sort((a, b) => (rank.indexOf(a.id) < 0 ? Infinity : rank.indexOf(a.id)) - (rank.indexOf(b.id) < 0 ? Infinity : rank.indexOf(b.id)));
    const unidentified = linked.filter(a => a.alias === 'Unidentified').map(a => a.id).sort();
    for (const account of linked) {
      const suffix = account.alias === 'Unidentified' ? String(unidentified.indexOf(account.id) + 1) : undefined;
      const accountLabel = `${account.alias}${suffix ? ` · ${suffix}` : ''}`, label = linked.length > 1 ? accountLabel : name(agent);
      result.push({ platform: agent.agent, platformLabel: name(agent), accountLabel, accessibleLabel: `${name(agent)} · ${accountLabel}`, id: JSON.stringify(['agent', agent.agent, account.id]), side: 'local', agent: agent.agent,
      accountId: account.id, sourceIds: [], label,
      content: <AgentAccountNode account={account} suffix={suffix} candidateLabel={label} agent={agent.agent} state={agent.available ? 'normal' : 'inactive'} onOpen={() => open(1, agent.agent, undefined, account.id)} /> });
    }
    if (!linked.length) result.push({ id: JSON.stringify(['agent', agent.agent]), side: 'local', agent: agent.agent, platform: agent.agent, platformLabel: name(agent), sourceIds: [], label: name(agent), accessibleLabel: name(agent),
      content: <AgentPlatformNode agent={agent} quota={null} state={agent.available ? 'normal' : 'inactive'} onOpen={() => open(1, agent.agent)} /> });
  }
  // Apply per-platform account order only to that platform's persisted slots.
  for (const platform of new Set(sources.map(source => source.product))) {
    const indices = result.flatMap((c, i) => !c.agent && sources.some(source => source.product === platform && c.sourceIds.includes(source.id)) ? [i] : []);
    const rank = orders[`-1:${platform}`] ?? [];
    const rows = indices.map(i => result[i]).sort((a, b) =>
      (rank.indexOf(a.accountId!) < 0 ? Infinity : rank.indexOf(a.accountId!)) - (rank.indexOf(b.accountId!) < 0 ? Infinity : rank.indexOf(b.accountId!)));
    indices.forEach((index, i) => { result[index] = rows[i]; });
  }
  return result;
}
export function canonicalAccount(accounts: ProviderAccount[], id?: string | null) { return accounts.find(a => accountOwns(a, id))?.id ?? id; }
