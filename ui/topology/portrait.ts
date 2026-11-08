import { DEFAULTS, hubDots, MIN_HUB_RATIO, type Drag, type Entity, type Layout, type NodeGeometry, type Params, type Scene, type Side, type TaskGeometry, type Wing } from './solve.ts';
import { bubbleWidths } from '../state/activityModel.ts';
import { taskHierarchy } from '../state/taskHierarchy.ts';
import { hubControlGeometry } from './geometry.ts';

export interface PortraitGeometry {
  sourceX: number; agentX: number; sourceTop: number; sourceBottom: number; agentTop: number; agentBottom: number;
  rowGap: number;
  earOffset: number; earHalf: number;
}
export const portraitInset = 74;
export const portraitMobileBreakpoint = 520;

// Portrait owns rows and inward columns. Queue selection and account identity
// remain upstream, so switching orientation never rewrites either ordering.
export function solvePortrait(sc: Scene, p: Params = DEFAULTS, drag: Drag | null = null): Layout {
  const { vw, vh } = sc;
  const mobile = vw <= portraitMobileBreakpoint;
  const railInset = (mobile ? 16 : 24) + p.nodeSize / 2 + 3;
  const column = Math.min(96, Math.max(56, p.nodeSize + 12, mobile ? 0 : vw * 0.15));
  const busGap = Math.min(62, Math.max(30, vw * 62 / 900));
  const finalStub = Math.min(24, Math.max(12, vw * 24 / 900));
  const preferredRe = (mobile ? 106 * 130 / 240 : Math.min(112, vw * 0.16, Math.max(56, vh * 0.08)) * 0.6) * p.ringScale;
  const Re = Math.max(preferredRe * MIN_HUB_RATIO, Math.min(preferredRe, (vw - 32) * 130 / 240));
  const hubClearance = Re * (mobile ? 0.4 : 0.6);
  const taskInset = 10;
  const earOffset = Re, earHalf = Re * 72 / 112;
  const hasTasks = (e: Entity): boolean => !e.collapsed && (e.tasks.length > 0 || !!e.children?.some(hasTasks));
  const busy = sc.right.some(hasTasks);
  const agentHubClearance = busy ? Math.max(hubClearance, hubControlGeometry(Re).powerBottom - taskInset) : hubClearance;
  const right = [...sc.right.filter(hasTasks), ...sc.right.filter(e => !hasTasks(e))];
  const children = (e: Entity) => e.collapsed ? [] : e.children ?? [];
  const tasks = (e: Entity) => e.collapsed ? [] : e.tasks;
  const sourceX = railInset, agentX = vw - railInset;
  const hierarchy = (right.some(e => children(e).length) ? column : 0) + busGap + finalStub;
  const taskRight = agentX - hierarchy;
  const stackHeight = (e: Entity) => tasks(e).reduce((h, t) => h + t.height, 0) + Math.max(0, tasks(e).length - 1) * p.taskGap;
  const rowHeight = (e: Entity, side: Side, account = false): number => {
    const nested = children(e), own = stackHeight(e);
    const rootRow = side === -1 ? p.sourceRow - DEFAULTS.sourceRow : p.idleRow - DEFAULTS.idleRow;
    const base = account ? p.nodeSize + 24 : Math.max(p.nodeSize, side === 1 && busy && !hasTasks(e) ? p.minIdleRow : p.nodeSize + rootRow);
    const subtree = nested.reduce((h, child) => h + rowHeight(child, side, true), 0) + Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap);
    return Math.max(base, own + (own ? 2 * taskInset : 0) + subtree + (own && subtree ? p.rowGap : 0));
  };
  const sourceCount = sc.left.length, agentCount = right.length;
  const gaps = Math.max(0, sourceCount - 1) + Math.max(0, agentCount - 1);
  const minimum = sc.left.reduce((h, root) => h + rowHeight(root, -1), 0)
    + right.reduce((h, root) => h + rowHeight(root, 1), 0) + gaps * p.rowGap;
  // Spend spare height on the rails before sibling groups need to fold.
  const spare = Math.max(0, vh - 2 * portraitInset - hubClearance - agentHubClearance - minimum);
  const sourceHubWeight = sourceCount ? 0.75 : 0;
  const agentHubWeight = agentCount ? (busy ? 0.4 : 0.75) : 0;
  const slots = gaps + sourceHubWeight + agentHubWeight;
  const extra = slots ? Math.min(mobile ? 6 : 34, Math.max(0, (vh - 500) * 0.075), spare / slots) : 0;
  const rowGap = p.rowGap + extra;
  const sourceClearance = hubClearance + extra * sourceHubWeight;
  const agentClearance = agentHubClearance + extra * agentHubWeight;
  function wing(list: readonly Entity[], side: Side, top: number): Wing {
    const nodes: NodeGeometry[] = [], bubbles: TaskGeometry[] = [];
    const place = (e: Entity, y: number, x: number, parent?: string): number => {
      const height = rowHeight(e, side, !!parent), own = tasks(e), nested = children(e);
      const active = hasTasks(e), idle = side === 1 && busy && !active && !parent;
      const node: NodeGeometry = { id: e.id, parent, tasks: own, active, side, x, y: y + height / 2,
        size: p.nodeSize, scale: 1, rowHeight: height,
        opacity: idle ? 0.62 : 1, dim: idle, port: 0, arc: null,
        taskBusX: x - busGap, childBusX: x - side * column / 2 };
      if (drag?.kind === 'node' && drag.side === side && drag.id === e.id) {
        node.x = drag.x; node.y = drag.y;
        node.taskBusX = drag.x - busGap; node.childBusX = drag.x - side * column / 2;
      }
      nodes.push(node);
      let taskY = nested.length ? y + taskInset : node.y - stackHeight(e) / 2;
      for (const { task, depth, parentTaskId } of taskHierarchy(own)) {
        const available = Math.min(Math.max(bubbleWidths.narrow, Math.min(480, taskRight - 16)), Math.max(1, taskRight - 16));
        const indent = Math.min(depth * 28, Math.max(0, available - 160));
        const width = available - indent;
        const moved = drag?.kind === 'task' && drag.side === side && drag.id === task.id;
        bubbles.push({ ...task, parentTaskId, width, parent: e.id, side, port: 0, anchor: 1,
          x: moved ? Math.max(width + 16, Math.min(taskRight - indent, drag.x)) : taskRight - indent,
          y: moved ? drag.y : taskY + task.height / 2 });
        taskY += task.height + p.taskGap;
      }
      let childY = y + (own.length ? stackHeight(e) + 2 * taskInset + p.rowGap : (height - nested.reduce((h, c) => h + rowHeight(c, side, true), 0) - Math.max(0, nested.length - 1) * (side === -1 ? 0 : p.rowGap)) / 2);
      for (const child of nested) childY += place(child, childY, x - side * column, e.id) + (side === -1 ? 0 : p.rowGap);
      return height;
    };
    let y = top;
    for (const e of list) y += place(e, y, side === -1 ? sourceX : agentX) + rowGap;
    return { side, nodes, tasks: bubbles, H: Math.max(0, y - top - rowGap), ear: { lo: 0, hi: 0 } };
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
    for (const task of wing.tasks) { task.hidden = true; task.x += 12; }
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
// Coordinates are scene-local. The host converts them into viewport coordinates;
// vertical scrolling never feeds a panel's animated dimensions back into solve.
export function portraitPanelRect(layout: Layout, selected: NodeGeometry): PortraitPanelRect {
  if (selected.side === -1) {
    const sources = layout.wings[0].nodes.filter(node => node.opacity > 0);
    const edge = Math.max(...sources.map(node => node.x + node.size * node.scale / 2));
    const x = Math.min(layout.vw - 17, edge + 24);
    return { x, y: 16, width: Math.max(1, layout.vw - 16 - x), height: Math.max(1, layout.vh - 112) };
  }
  const right = selected.x - selected.size * selected.scale / 2 - 40;
  return { x: 16, y: 16, width: Math.max(1, right - 16), height: Math.max(1, layout.vh - 112) };
}
