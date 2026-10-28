import GraphNode from '../components/GraphNode';
import SourceIcon from '../components/SourceIcon';
import type { NodeView } from './Topology';
import { accountNodeId, sourcePlatformNodeId, type TopologyAccount } from './accounts';
import { orderedSubset } from './order';
import { AgentQuotaIcon } from '../subscriptions/QuotaRing';

export interface AccountNodeActions {
  selectedPlatform?: string;
  openPlatform?: (platform: string) => void;
  open: (side: -1 | 1, platform: string, sourceId?: string, accountId?: string) => void;
}
// Account/product entry keys survive Tree/Flat switches. Connections never create identities.
export function accountViews(views: NodeView[], side: -1 | 1, accounts: TopologyAccount[], mode: 'tree' | 'flat', orders: Record<string, string[]>, actions: AccountNodeActions): NodeView[] {
  if (!accounts.length) return views;
  const platforms = new Map<string, NodeView[]>();
  views.forEach(view => { const id = view.platform ?? view.id; platforms.set(id, [...platforms.get(id) ?? [], view]); });
  return [...platforms].flatMap(([platform, members]) => {
    const linked = orderedSubset(accounts.filter(a => side === 1 ? a.agentProfiles.some(p => p.agent === platform) : a.sources.some(id => members.some(v => v.id === id))), orders[`${side}:${platform}`] ?? []);
    // Partial snapshots cannot silently hide unassociated sources or tasks.
    if (!linked.length) return members;
    const covered = side === -1 ? members.filter(v => linked.some(a => a.sources.includes(v.id))) : members;
    const first = covered[0], label = first.platformLabel ?? platform;
    const unmatched = side === -1 ? members.filter(v => !linked.some(a => a.sources.includes(v.id))) : [];
    const tasks = members.flatMap(v => v.tasks);
    const entries = linked.flatMap(account => {
      const sources = members.filter(view => account.sources.includes(view.id));
      const products = side === -1 ? [...new Set(sources.map(view => view.sourceProduct))] : [undefined];
      return products.map(product => ({ account, product, sources: sources.filter(view => product === undefined || view.sourceProduct === product) }));
    });
    const multipleProducts = side === -1 && new Set(covered.map(view => view.sourceProduct)).size > 1;
    if (entries.length === 1) {
      // Single-account platforms keep their node, label, quota and bubble slots.
      // Multiple connections of this identity and product share one node.
      const account = linked[0];
      return [{ ...first, label, accountId: account.id, sourceIds: covered.map(v => v.id), tasks,
        selected: covered.some(v => v.selected) || actions.selectedPlatform === platform, sameIdentity: account.sources.length > 0 && account.agentProfiles.length > 0 }, ...unmatched];
    }
    // Equal aliases (including Unidentified) never merge distinct ARC account IDs.
    const unidentified = linked.filter(a => a.alias === 'Unidentified').map(a => a.id).sort();
    const platformIcon = side === 1 ? <AgentQuotaIcon agent={platform} quota={null} /> : <SourceIcon platform={platform} panelVisual />;
    const childViews = entries.map(({ account, product, sources }) => {
      const selected = side === -1 ? sources.some(v => v.selected) : members.some(v => v.selected) && members.some(v => v.selectedAccountId === account.id);
      const sameIdentity = account.sources.length > 0 && account.agentProfiles.length > 0;
      const state = side === -1 ? sources.find(v => v.state === 'normal')?.state ?? sources[0]?.state ?? first.state : first.state;
      const suffix = account.alias === 'Unidentified' ? String(unidentified.indexOf(account.id) + 1) : undefined;
      const alias = suffix ? `${account.alias} · ${suffix}` : account.alias;
      const entryLabel = multipleProducts ? `${sources[0].sourceProductLabel ?? product}${linked.length > 1 ? ` · ${alias}` : ''}` : alias;
      const nodeLabel = mode === 'flat' ? `${label} · ${entryLabel}` : entryLabel;
      const icon = side === 1 ? <AgentQuotaIcon agent={platform} quota={account.quota ?? null} /> : sources[0].icon;
      return {
        ...first, id: multipleProducts ? JSON.stringify(['source-entry', platform, account.id, product]) : accountNodeId(platform, account.id),
        sourceProduct: multipleProducts ? product : undefined, accountId: account.id, sourceIds: sources.map(v => v.id),
        selected, account: true, sameIdentity, label: nodeLabel, icon,
        attention: tasks.some(t => t.agentAccountId === account.id && (t.state === 'attention' || t.pending)),
        state,
        tasks: tasks.filter(t => t.agentAccountId === account.id),
        content: <GraphNode label={nodeLabel} state={state} highlighted={selected} onOpen={() => actions.open(side, platform, sources[0]?.id, account.id)}>
          {icon}
          <span className={`graph-node-name${suffix && !multipleProducts ? ' topology-unidentified-label' : ''}`}>
            {suffix && !multipleProducts ? <><span>{mode === 'flat' ? `${label} · ${account.alias}` : account.alias}</span><span> · {suffix}</span></> : nodeLabel}
          </span>
        </GraphNode>,
      } satisfies NodeView;
    });
    const state = side === -1 ? (['normal', 'connecting', 'error', 'inactive'] as const).find(state => covered.some(view => view.state === state)) ?? first.state : first.state;
    const selected = actions.selectedPlatform === platform || side === 1 && covered.some(v => v.selected) && !childViews.some(v => v.selected);
    const platformView: NodeView = { ...first, id: side === 1 ? platform : sourcePlatformNodeId(platform), platform, platformRoot: side === -1,
      label, icon: platformIcon, state, sourceIds: covered.map(v => v.id), selected,
      tasks: tasks.filter(t => !linked.some(a => a.id === t.agentAccountId)),
      content: <GraphNode label={label} state={state} highlighted={selected} onOpen={() => actions.openPlatform?.(platform)}>
        {platformIcon}<span className="graph-node-name">{label}</span>
      </GraphNode>,
    };
    if (mode === 'flat') {
      // Legacy unattributed tasks remain attached to their platform, never guessed.
      if (platformView.tasks.length) return [...childViews, { ...platformView, selected: false }, ...unmatched];
      return [...childViews, ...unmatched];
    }
    return [{ ...platformView, children: childViews }, ...unmatched];
  });
}
