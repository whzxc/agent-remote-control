import { GraphNode } from '../components/ui/GraphNode';
import SourceIcon from '../components/SourceIcon';
import type { NodeView } from './Topology';
import { sourcePlatformNodeId } from './accounts';

export interface AccountNodeActions {
  selectedPlatform?: string;
  openPlatform?: (platform: string) => void;
  open: (side: -1 | 1, platform: string, sourceId?: string) => void;
}

// Source IDs identify connector instances on the left wing; right-wing Agents are single-node executors.
export function accountViews(views: NodeView[], side: -1 | 1, mode: 'tree' | 'flat', actions: AccountNodeActions): NodeView[] {
  if (side !== -1) return views;
  const groups = new Map<string, NodeView[]>();
  for (const view of views) { const id = view.platform ?? view.id; groups.set(id, [...groups.get(id) ?? [], view]); }
  return [...groups].flatMap<NodeView>(([platform, members]) => {
    const first = members[0], label = first.platformLabel ?? platform;
    const children = members.map(view => ({ ...view, account: true, content: <GraphNode label={view.label ?? view.id} state={view.state} highlighted={view.selected} hideLabel={view.selected} panelExpanded={view.selected} caption={<span className="graph-node-name">{view.label}</span>} onOpen={() => actions.open(-1, platform, view.id)}>{view.icon}</GraphNode> }));
    if (mode === 'flat' || members.length === 1) return children;
    const selected = actions.selectedPlatform === platform;
    const state = (['normal', 'connecting', 'error', 'inactive'] as const).find(state => members.some(view => view.state === state)) ?? first.state;
    const icon = <SourceIcon platform={platform} panelVisual />;
    return [{ ...first, id: sourcePlatformNodeId(platform), platformRoot: true, label, selected, state, icon, quota: undefined, sourceIds: members.map(view => view.id), children,
      content: <GraphNode caption={<span className="graph-node-name">{label}</span>} hideLabel={selected} panelExpanded={selected} label={label} state={state} highlighted={selected} onOpen={() => actions.openPlatform?.(platform)}>{icon}</GraphNode> }];
  });
}
