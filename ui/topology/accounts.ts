import type { Side } from './solve';

import type { ProviderAccount, AgentActivitySession } from '../types';

// Topology consumes the native account identity and recorded task attribution.
export type TopologyAccount = Pick<ProviderAccount, 'id' | 'provider' | 'identityKey' | 'alias' | 'sources' | 'agentProfiles' | 'quota'>;
export type AccountAttribution = Pick<AgentActivitySession, 'agentAccountId' | 'origin'>;
export interface PathTask extends AccountAttribution { id: string; members?: (AccountAttribution & { pending?: boolean })[] }
export interface PathNode {
  id: string; side: Side; parent?: string; accountId?: string; sourceIds?: string[];
  tasks: PathTask[];
}
export const sourcePlatformNodeId = (platform: string) => `platform:${platform}`;
export const accountNodeId = (platform: string, account: string) => JSON.stringify(['account', platform, account]);

// Union complete paths before projecting hidden descendants onto visible ancestors.
export function highlightedPaths(nodes: PathNode[], target: { side: Side; id: string; task?: boolean } | null) {
  if (!target) return null;
  const key = (n: Pick<PathNode, 'side' | 'id'>) => JSON.stringify([n.side, n.id]);
  const lit = new Set<string>();
  const add = (node: PathNode | undefined) => {
    if (!node || lit.has(key(node))) return;
    lit.add(key(node));
    if (node.parent) add(nodes.find(n => n.side === node.side && n.id === node.parent));
  };
  const selected = nodes.find(n => n.side === target.side && (target.task ? n.tasks.some(t => t.id === target.id) : n.id === target.id));
  if (!selected) return null;
  const descendants = (n: PathNode | undefined): boolean => !!n && (n === selected || !!n.parent && descendants(nodes.find(p => p.side === n.side && p.id === n.parent)));
  const seeds = nodes.filter(descendants);
  seeds.forEach(add);
  for (const agent of nodes.filter(n => n.side === 1)) for (const task of agent.tasks) {
    const sources = nodes.filter(n => n.side === -1 && (task.members ?? [task]).some(({ origin }) => origin?.accountId ? n.accountId === origin.accountId : !!origin?.sourceId && n.sourceIds?.includes(origin.sourceId)));
    const relevant = target.task ? task.id === target.id : seeds.includes(agent) || sources.some(n => seeds.includes(n));
    if (!relevant) continue;
    add(agent); sources.forEach(add); lit.add(JSON.stringify(['task', 1, task.id]));
  }
  // A same-identity counterpart is a shared ARC account, not a matching alias.
  const identities = new Set(nodes.filter(n => lit.has(key(n))).map(n => n.accountId).filter(Boolean));
  nodes.filter(n => n.accountId && identities.has(n.accountId)).forEach(add);
  return lit;
}
