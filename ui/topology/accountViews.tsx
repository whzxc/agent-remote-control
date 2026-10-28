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
// Source IDs identify connector instances; Agent profiles retain account-scoped tasks.
export function accountViews(views: NodeView[], side: -1 | 1, accounts: TopologyAccount[], mode: 'tree' | 'flat', orders: Record<string, string[]>, actions: AccountNodeActions): NodeView[] {
  if (side === -1) {
    const groups = new Map<string, NodeView[]>();
    for (const view of views) { const id = view.platform ?? view.id; groups.set(id, [...groups.get(id) ?? [], view]); }
    return [...groups].flatMap<NodeView>(([platform, members]) => {
      const first = members[0], label = first.platformLabel ?? platform;
      const children = members.map(view => ({ ...view, account: true, content: <GraphNode label={view.label ?? view.id} state={view.state} highlighted={view.selected} onOpen={() => actions.open(-1, platform, view.id)}>{view.icon}<span className="graph-node-name">{view.label}</span></GraphNode> }));
      if (mode === 'flat') return children;
      const selected = actions.selectedPlatform === platform;
      const state = (['normal', 'connecting', 'error', 'inactive'] as const).find(state => members.some(view => view.state === state)) ?? first.state;
      const icon = <SourceIcon platform={platform} panelVisual />;
      return [{ ...first, id: sourcePlatformNodeId(platform), platformRoot: true, label, selected, state, icon, sourceIds: members.map(view => view.id), children,
        content: <GraphNode label={label} state={state} highlighted={selected} onOpen={() => actions.openPlatform?.(platform)}>{icon}<span className="graph-node-name">{label}</span></GraphNode> }];
    });
  }
  if (!accounts.length) return views;
  const platforms = new Map<string, NodeView[]>();
  views.forEach(view => { const id = view.platform ?? view.id; platforms.set(id, [...platforms.get(id) ?? [], view]); });
  return [...platforms].flatMap<NodeView>(([platform, members]) => {
    const linked = orderedSubset(accounts.filter(a => a.agentProfiles.some(p => p.agent === platform)), orders[`1:${platform}`] ?? []);
    if (!linked.length) return members;
    const first = members[0], label = first.platformLabel ?? platform;
    const tasks = members.flatMap(v => v.tasks);
    if (linked.length === 1) {
      return [{ ...first, label, accountId: linked[0].id, tasks, selected: members.some(v => v.selected) }];
    }
    const unidentified = linked.filter(a => a.alias === 'Unidentified').map(a => a.id).sort();
    const platformIcon = <AgentQuotaIcon agent={platform} quota={null} />;
    const children = linked.map(account => {
      const selected = members.some(v => v.selected && v.selectedAccountId === account.id);
      const suffix = account.alias === 'Unidentified' ? String(unidentified.indexOf(account.id) + 1) : undefined;
      const alias = suffix ? `${account.alias} · ${suffix}` : account.alias;
      const nodeLabel = mode === 'flat' ? `${label} · ${alias}` : alias;
      const icon = <AgentQuotaIcon agent={platform} quota={account.quota ?? null} />;
      return { ...first, id: accountNodeId(platform, account.id), accountId: account.id, selected, account: true, label: nodeLabel, icon,
        attention: tasks.some(t => t.agentAccountId === account.id && (t.state === 'attention' || t.pending)),
        tasks: tasks.filter(t => t.agentAccountId === account.id),
        content: <GraphNode label={nodeLabel} state={first.state} highlighted={selected} onOpen={() => actions.open(1, platform, undefined, account.id)}>
          {icon}<span className={`graph-node-name${suffix ? ' topology-unidentified-label' : ''}`}>
            {suffix ? <><span>{mode === 'flat' ? `${label} · ${account.alias}` : account.alias}</span><span> · {suffix}</span></> : nodeLabel}
          </span>
        </GraphNode>,
      } satisfies NodeView;
    });
    const selected = members.some(v => v.selected) && !children.some(v => v.selected);
    const root: NodeView = { ...first, id: platform, label, icon: platformIcon, selected,
      tasks: tasks.filter(t => !linked.some(a => a.id === t.agentAccountId)),
      content: <GraphNode label={label} state={first.state} highlighted={selected} onOpen={() => actions.openPlatform?.(platform)}>
        {platformIcon}<span className="graph-node-name">{label}</span>
      </GraphNode>,
    };
    return mode === 'tree' ? [{ ...root, children }] : [...children, ...(root.tasks.length ? [{ ...root, selected: false }] : [])];
  });
}
