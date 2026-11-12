import { DEFAULTS, hubDots, MIN_HUB_RATIO, type Drag, type Entity, type Layout, type NodeGeometry, type Params, type Scene, type Side, type Wing } from './solve.ts';

export interface PortraitGeometry {
  sourceX: number; agentX: number; sourceTop: number; sourceBottom: number; agentTop: number; agentBottom: number;
  rowGap: number;
  earOffset: number; earHalf: number;
}
export const portraitInset = 74;
export const portraitMobileBreakpoint = 520;

// Portrait owns node rows and inward columns. Configuration order and account identity remain upstream.
export function solvePortrait(sc: Scene, p: Params = DEFAULTS, drag: Drag | null = null): Layout {
  const { vw, vh } = sc;
  const mobile = vw <= portraitMobileBreakpoint;
  const railInset = (mobile ? 16 : 24) + p.nodeSize / 2 + 3;
  const column = Math.min(96, Math.max(56, p.nodeSize + 12, mobile ? 0 : vw * 0.15));
  const preferredRe = (mobile ? 106 * 130 / 240 : Math.min(112, vw * 0.16, Math.max(56, vh * 0.08)) * 0.6) * p.ringScale;
  const Re = Math.max(preferredRe * MIN_HUB_RATIO, Math.min(preferredRe, (vw - 32) * 130 / 240));
  const hubClearance = Re * (mobile ? 0.4 : 0.6);
  const earOffset = Re, earHalf = Re * 72 / 112;
  const agentHubClearance = hubClearance;
  const right = sc.right;
  const children = (e: Entity) => e.collapsed ? [] : e.children ?? [];
  const extent = (list: readonly Entity[]): number => Math.max(48, ...list.map(node => node.extent ?? 48));
  const sourceX = Math.max(railInset, (mobile ? 16 : 24) + (extent(sc.left) - 24) * p.nodeSize / 44);
  const agentX = vw - Math.max(railInset, (mobile ? 16 : 24) + (extent(right) - 24) * p.nodeSize / 44);
  const rowHeight = (e: Entity, side: Side, account = false): number => {
    const nested = children(e);
    const rootRow = side === -1 ? p.sourceRow - DEFAULTS.sourceRow : p.idleRow - DEFAULTS.idleRow;
    const base = account ? p.nodeSize + 24 : Math.max(p.nodeSize, p.nodeSize + rootRow);
    const subtree = nested.reduce((h, child) => h + rowHeight(child, side, true), 0) + Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap);
    return Math.max(base, subtree);
  };
  const sourceCount = sc.left.length, agentCount = right.length;
  const gaps = Math.max(0, sourceCount - 1) + Math.max(0, agentCount - 1);
  const minimum = sc.left.reduce((h, root) => h + rowHeight(root, -1), 0)
    + right.reduce((h, root) => h + rowHeight(root, 1), 0) + gaps * p.rowGap;
  // Spend spare height on the rails before sibling groups need to fold.
  const spare = Math.max(0, vh - 2 * portraitInset - hubClearance - agentHubClearance - minimum);
  const sourceHubWeight = sourceCount ? 0.75 : 0;
  const agentHubWeight = agentCount ? 0.75 : 0;
  const slots = gaps + sourceHubWeight + agentHubWeight;
  const extra = slots ? Math.min(mobile ? 6 : 34, Math.max(0, (vh - 500) * 0.075), spare / slots) : 0;
  const rowGap = p.rowGap + extra;
  const sourceClearance = hubClearance + extra * sourceHubWeight;
  const agentClearance = agentHubClearance + extra * agentHubWeight;
  function wing(list: readonly Entity[], side: Side, top: number): Wing {
    const nodes: NodeGeometry[] = [];
    const place = (e: Entity, y: number, x: number, parent?: string): number => {
      const height = rowHeight(e, side, !!parent), nested = children(e);
      const active = nested.length > 0, idle = false;
      const node: NodeGeometry = { id: e.id, parent, extent: e.extent ?? 48, active, side, x, y: y + height / 2,
        size: e.endpoint ? 12 : p.nodeSize, scale: 1, rowHeight: height,
        opacity: idle ? 0.62 : 1, dim: idle, port: 0, arc: null,
        childBusX: x - side * column / 2 };
      if (drag?.kind === 'node' && drag.side === side && drag.id === e.id) {
        node.x = drag.x; node.y = drag.y;
        node.childBusX = drag.x - side * column / 2;
      }
      nodes.push(node);
      let childY = y + (height - nested.reduce((h, c) => h + rowHeight(c, side, true), 0) - Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap)) / 2;
      for (const child of nested) childY += place(child, childY, x - side * column, e.id) + (side === -1 ? 0 : p.rowGap);
      return height;
    };
    let y = top;
    for (const e of list) y += place(e, y, side === -1 ? sourceX : agentX) + rowGap;
    return { side, nodes, H: Math.max(0, y - top - rowGap), ear: { lo: 0, hi: 0 } };
  }
  const sourceTop = portraitInset, left = wing(sc.left, -1, sourceTop);
  const sourceBottom = sourceTop + left.H;
  const hub = { x: vw / 2, y: sourceBottom + sourceClearance, Re, ...hubDots(sc.hubInteraction) };
  const agentTop = hub.y + agentClearance, agents = wing(right, 1, agentTop);
  const agentBottom = agentTop + agents.H;
  for (const wing of [left, agents]) {
    if (sc.panel?.side !== wing.side) continue;
    const hidden = new Set<string>();
    for (const node of wing.nodes) {
      if (node.parent && (node.parent === sc.panel.selected || hidden.has(node.parent))) { node.opacity = 0; hidden.add(node.id); }
    }
  }
  return { vw, vh, sceneH: Math.max(vh, agentBottom + portraitInset), hub, wings: [left, agents],
    portrait: { sourceX, agentX, sourceTop, sourceBottom, agentTop, agentBottom, rowGap, earOffset, earHalf },
    balance: [{ core: sourceX, full: vw / 2, squeeze: 1 }, { core: vw - agentX, full: vw / 2, squeeze: 1 }] };
}

export interface PortraitPanelRect { x: number; y: number; width: number; height: number }
export function portraitSourcePanelRoute(node: Pick<NodeGeometry, 'x' | 'y' | 'size' | 'scale'>, panel: PortraitPanelRect) {
  const radius = node.size * node.scale / 2;
  const start = { x: node.x + radius + 4, y: node.y };
  const end = { x: panel.x, y: Math.max(panel.y + 27, Math.min(panel.y + panel.height - 27, node.y)) };
  return [start, { x: panel.x - 12, y: node.y }, { x: panel.x - 12, y: end.y }, end];
}
