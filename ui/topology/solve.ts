import type { PortraitGeometry } from "./portrait.ts";
// Metadata is the single source for solver defaults, controls and validation.
export const PARAMETER_GROUPS = {
  balance: { en: "Fitting", "zh-CN": "空间适配" },
  hub: { en: "Hub and earmuffs", "zh-CN": "中心与耳罩" },
  primary: { en: "Primary branches", "zh-CN": "一级触手" },
  secondary: { en: "Outer arcs and task branches", "zh-CN": "外弧与二级触手" },
  rows: { en: "Rows", "zh-CN": "行布局" },
  motion: { en: "Motion", "zh-CN": "动效" },
} as const;
export const PARAMETERS = [
  { key: "margin", group: "balance", label: { en: "Window margin", "zh-CN": "窗口留白" }, min: 16, max: 120, step: 2, default: 40 },
  { key: "squeezeMin", group: "balance", label: { en: "Minimum column ratio", "zh-CN": "最小列距比例" }, min: 0.5, max: 1, step: 0.02, default: 0.72 },
  { key: "ringScale", group: "hub", label: { en: "Ring size", "zh-CN": "环尺寸" }, min: 0.6, max: 1.4, step: 0.02, default: 1 },
  { key: "earFollow", group: "hub", label: { en: "Port target following", "zh-CN": "端口随目标" }, min: 0, max: 1, step: 0.05, default: 0.7 },
  { key: "earSep", group: "hub", label: { en: "Minimum port spacing (°)", "zh-CN": "端口最小间隔°" }, min: 2, max: 16, step: 0.5, default: 7 },
  { key: "earMax", group: "hub", label: { en: "Maximum half-angle (°)", "zh-CN": "最大半角°" }, min: 20, max: 60, step: 1, default: 42 },
  { key: "earMin", group: "hub", label: { en: "Minimum half-angle (°)", "zh-CN": "最小半角°" }, min: 8, max: 40, step: 1, default: 22 },
  { key: "earPad", group: "hub", label: { en: "Arc end padding (°)", "zh-CN": "弧端余量°" }, min: 0, max: 16, step: 1, default: 7 },
  { key: "t1Node", group: "primary", label: { en: "Node tension", "zh-CN": "节点端张力" }, min: 0.1, max: 0.8, step: 0.02, default: 0.42 },
  { key: "t1Root", group: "primary", label: { en: "Root tension", "zh-CN": "根部端张力" }, min: 0.05, max: 0.7, step: 0.02, default: 0.3 },
  { key: "flare", group: "primary", label: { en: "Root flare", "zh-CN": "根部展宽" }, min: 0, max: 2, step: 0.05, default: 1 },
  { key: "arcGap", group: "secondary", label: { en: "Outer arc gap", "zh-CN": "外弧间距" }, min: 4, max: 30, step: 1, default: 11 },
  { key: "arcFollow", group: "secondary", label: { en: "Port target following", "zh-CN": "端口随目标" }, min: 0, max: 1, step: 0.05, default: 0.75 },
  { key: "arcMax", group: "secondary", label: { en: "Maximum half-angle (°)", "zh-CN": "最大半角°" }, min: 20, max: 75, step: 1, default: 58 },
  { key: "arcPad", group: "secondary", label: { en: "Arc end padding (°)", "zh-CN": "弧端余量°" }, min: 0, max: 20, step: 1, default: 9 },
  { key: "bubbleOffset", group: "secondary", label: { en: "Bubble offset", "zh-CN": "气泡距节点" }, min: 60, max: 220, step: 2, default: 104 },
  { key: "t2Root", group: "secondary", label: { en: "Root tension", "zh-CN": "根部端张力" }, min: 0.05, max: 0.7, step: 0.02, default: 0.34 },
  { key: "t2End", group: "secondary", label: { en: "Bubble tension", "zh-CN": "气泡端张力" }, min: 0.1, max: 0.8, step: 0.02, default: 0.5 },
  { key: "nodeSize", group: "rows", label: { en: "Node size", "zh-CN": "节点大小" }, min: 32, max: 60, step: 1, default: 44 },
  { key: "colDist", group: "rows", label: { en: "Column distance", "zh-CN": "节点列距" }, min: 2, max: 3.2, step: 0.02, default: 2.6 },
  { key: "taskGap", group: "rows", labelKey: "topology.taskGap", min: 0, max: 30, step: 1, default: 10 },
  { key: "rowGap", group: "rows", label: { en: "Row gap", "zh-CN": "行间距" }, min: 0, max: 30, step: 1, default: 12 },
  { key: "sourceRow", group: "rows", label: { en: "Source row height", "zh-CN": "控制源行高" }, min: 56, max: 96, step: 1, default: 78 },
  { key: "idleRow", group: "rows", label: { en: "Idle Agent row height", "zh-CN": "Agent 空闲行高" }, min: 40, max: 96, step: 1, default: 78 },
  { key: "idleIndent", group: "rows", label: { en: "Idle indentation", "zh-CN": "空闲左缩进" }, min: 0, max: 60, step: 1, default: 22 },
  { key: "activeScale", group: "rows", label: { en: "Active scale", "zh-CN": "活跃缩放" }, min: 1, max: 1.4, step: 0.02, default: 1.1 },
  { key: "idleScale", group: "rows", label: { en: "Idle scale", "zh-CN": "空闲缩放" }, min: 0.6, max: 1, step: 0.02, default: 1 },
  { key: "minIdleScale", group: "rows", label: { en: "Minimum idle scale", "zh-CN": "空闲缩放下限" }, min: 0.4, max: 0.9, step: 0.02, default: 0.6 },
  { key: "minIdleRow", group: "rows", label: { en: "Minimum idle row height", "zh-CN": "压缩下限" }, min: 34, max: 60, step: 1, default: 44 },
  { key: "stiffness", group: "motion", label: { en: "Stiffness", "zh-CN": "刚度" }, min: 60, max: 600, step: 5, default: 210 },
  { key: "damping", group: "motion", label: { en: "Damping", "zh-CN": "阻尼" }, min: 8, max: 60, step: 1, default: 26 },
] as const;
export type ParameterKey = typeof PARAMETERS[number]["key"];
export type Params = Record<ParameterKey, number>;
export const DEFAULTS = Object.fromEntries(PARAMETERS.map(p => [p.key, p.default])) as Params;
export type Side = -1 | 1;
export interface Task { id: string; width: number; height: number }
export interface Entity { id: string; tasks: readonly Task[]; children?: readonly Entity[]; collapsed?: boolean }
export interface Scene { vw: number; vh: number; left: readonly Entity[]; right: readonly Entity[]; hubInteraction?: "hub" | "source" | "agent"; panel?: { side: Side; edge: number; selected: string; narrow?: boolean; overlay?: boolean } }
export interface Drag extends Point { kind: "node" | "task"; side: Side; id: string }
export interface Point { x: number; y: number }
export interface NodeGeometry extends Point {
  id: string; parent?: string; tasks: readonly Task[]; active: boolean; size: number; scale: number; opacity: number; dim: boolean; side: Side;
  taskBusX?: number; childBusX?: number;
  port: number; arc: { R: number; lo: number; hi: number } | null;
}
export interface TaskGeometry extends Task, Point { parent: string; side: Side; port: number; hidden?: boolean; anchor?: number }
interface WingOptions { idleStyle: boolean; rowScale: number; squeeze: number }
interface Row { e: Entity; n: number; h: number }
export interface Wing { side: Side; H: number; nodes: NodeGeometry[]; ear: { lo: number; hi: number }; tasks: TaskGeometry[] }
export interface WingBalance { core: number; full: number; squeeze: number }
export interface Layout { portrait?: PortraitGeometry; balance: WingBalance[]; vw: number; vh: number; sceneH: number; hub: Point & { Re: number; dotSource?: number; dotAgent?: number }; wings: Wing[] }
export const deg = (d: number) => d * Math.PI / 180;
export const NODE_R = 22, LABEL_W = 110;
export const MIN_HUB_RATIO = 0.6;
export function hubDots(interaction: Scene["hubInteraction"]) {
  return { dotSource: interaction === 'source' ? 1.25 : interaction ? 1.1 : 1,
    dotAgent: interaction === 'agent' ? 1.25 : interaction ? 1.1 : 1 };
}
export const ACCOUNT_NODE_SIZE = 42;
export const PANEL_MIN_WIDTH = 400, PANEL_MARGIN = 16, PANEL_ARC_GAP = 40;

export const COLLAPSE_HIT_SIZE = 32, COLLAPSE_SYMBOL_SIZE = 20;

// Toggle coordinates follow the animated arc, including asymmetric fan-outs.
export function collapseTarget(radius: number, lo: number, hi: number, side: Side) {
  const angle = deg((lo + hi) / 2);
  return { x: side * radius * Math.cos(angle), y: radius * Math.sin(angle), hitSize: COLLAPSE_HIT_SIZE, symbolSize: COLLAPSE_SYMBOL_SIZE };
}

// The selected node's animated outer arc defines the dock's inner edge.
export function panelWidth(vw: number, side: Side, x: number, radius: number) {
  const remaining = side === 1 ? vw - x - radius - PANEL_ARC_GAP - PANEL_MARGIN
    : x - radius - PANEL_ARC_GAP - PANEL_MARGIN;
  return Math.min(Math.max(0, vw - 2 * PANEL_MARGIN), Math.max(PANEL_MIN_WIDTH, remaining));
}

// Distribute port angles: follow each target's direction, keep a minimum
// separation in order, and fit the run inside ±max. Returns degrees.
export function distribute(raw: number[], follow: number, sep: number, max: number) {
  const a = raw.map((r) => Math.max(-max, Math.min(max, r * follow)));
  for (let i = 1; i < a.length; i++) a[i] = Math.max(a[i], a[i - 1] + sep);
  const over = a.length ? a[a.length - 1] - max : 0;
  if (over > 0) for (let i = 0; i < a.length; i++) a[i] -= over;
  for (let i = a.length - 2; i >= 0; i--) a[i] = Math.min(a[i], a[i + 1] - sep);
  const lo = a.length ? a[0] : 0;
  if (lo < -max) {
    const span = a[a.length - 1] - a[0], scale = span > 0 ? (2 * max) / span : 1;
    for (let i = 0; i < a.length; i++) a[i] = -max + (a[i] - lo) * Math.min(1, scale);
  }
  return a;
}

// The agent wing styles idle nodes only while the scene has tasks.
// Without tasks, both wings use the same regular rows and node styling.
function wingRows(list: readonly Entity[], p: Params, opt: Pick<WingOptions, "idleStyle" | "rowScale">): Row[] {
  return list.map((e) => {
    const n = e.collapsed ? 0 : e.tasks.length;
    const base = opt.idleStyle ? Math.max(p.minIdleRow, p.idleRow * opt.rowScale) : Math.max(56, p.sourceRow * opt.rowScale);
    const taskHeight = (e.collapsed ? [] : e.tasks).reduce((height, task) => height + task.height, 0) + Math.max(0, n - 1) * p.taskGap;
    const childrenHeight = !e.collapsed && e.children?.length ? wingHeight(wingRows(e.children, p, { ...opt, idleStyle: false }), p) : 0;
    return { e, n: n + (e.collapsed ? 0 : e.children?.length ?? 0), h: Math.max(base, (n > 0 ? taskHeight + 20 : 0) + childrenHeight + (n > 0 && childrenHeight ? p.rowGap : 0)) };
  });
}
function wingHeight(rows: Row[], p: Params) { return rows.reduce((s, r) => s + r.h, 0) + p.rowGap * Math.max(0, rows.length - 1); }

function solveWing(list: readonly Entity[], side: Side, hub: Point, Re: number, p: Params, opt: WingOptions, drag: Drag | null): Wing {
  const rows = wingRows(list, p, opt);
  const H = wingHeight(rows, p);
  let y = hub.y - H / 2;
  const colX = hub.x + side * Re * p.colDist * opt.squeeze;
  const rowCompression = p.idleRow > p.minIdleRow ? (p.idleRow * opt.rowScale - p.minIdleRow) / (p.idleRow - p.minIdleRow) : 1;
  const columnCompression = p.squeezeMin < 1 ? (opt.squeeze - p.squeezeMin) / (1 - p.squeezeMin) : 1;
  const compression = Math.max(0, Math.min(1, rowCompression, columnCompression));
  const minIdleScale = Math.min(p.minIdleScale, p.idleScale);
  const idleScale = minIdleScale + (p.idleScale - minIdleScale) * compression;
  const idleIndent = p.idleIndent * (1 - compression);
  const nodes: NodeGeometry[] = rows.map((r) => {
    const active = r.n > 0, idle = opt.idleStyle && !active;
    const ny = y + r.h / 2; y += r.h + p.rowGap;
    const nodeDrag = drag && drag.kind === 'node' && drag.id === r.e.id;
    return { id: r.e.id, port: 0, arc: null, tasks: r.e.collapsed ? [] : r.e.tasks, active, x: nodeDrag ? drag.x : colX - side * (idle ? idleIndent : 0),
      y: nodeDrag ? drag.y : ny, size: p.nodeSize, scale: active ? p.activeScale : idle ? idleScale : 1, opacity: idle ? 0.62 : 1, dim: idle, side };
  });
  // Earmuff ports follow the direction from the hub to each node.
  const raw = nodes.map((n) => Math.atan2(n.y - hub.y, Math.abs(n.x - hub.x)) * 180 / Math.PI);
  const ang = distribute(raw, p.earFollow, p.earSep, p.earMax);
  nodes.forEach((n, i) => { n.port = ang[i]; });
  const lo = Math.min(-p.earMin, ang.length ? ang[0] - p.earPad : 0);
  const hi = Math.max(p.earMin, ang.length ? ang[ang.length - 1] + p.earPad : 0);
  // Task dimensions define ordered slots around the node, with ports on an outer arc.
  const tasks: TaskGeometry[] = [];
  nodes.forEach((n, index) => {
    if (!n.tasks.length) { n.arc = null; return; }
    const R = n.size / 2 * n.scale + p.arcGap;
    const height = n.tasks.reduce((height, task) => height + task.height, 0) + (n.tasks.length - 1) * p.taskGap;
    let edge = rows[index].e.children?.length ? n.y - rows[index].h / 2 + 10 : n.y - height / 2;
    const slots = n.tasks.map(task => {
      const center = edge + task.height / 2;
      edge += task.height + p.taskGap;
      return center;
    });
    const rawT = slots.map(y => Math.atan2(y - n.y, p.bubbleOffset) * 180 / Math.PI);
    const tA = distribute(rawT, p.arcFollow, 9, p.arcMax);
    n.arc = { R, lo: Math.min(-14, tA[0] - p.arcPad), hi: Math.max(14, tA[tA.length - 1] + p.arcPad) };
    n.tasks.forEach((t, i) => {
      const taskDrag = drag && drag.kind === 'task' && drag.id === t.id;
      tasks.push({ id: t.id, width: t.width, height: t.height, parent: n.id, side, port: tA[i],
        x: taskDrag ? drag.x : n.x + side * p.bubbleOffset, y: taskDrag ? drag.y : slots[i] });
    });
  });
  // Accounts reuse the mirrored wing algorithm, including their own task arcs.
  const descendants: NodeGeometry[] = [];
  rows.forEach((row, index) => {
    if (row.e.collapsed || !row.e.children?.length) return;
    const parent = nodes[index];
    const child = solveWing(row.e.children, side,
      { x: parent.x + side * (p.bubbleOffset - Re * p.colDist * opt.squeeze), y: parent.y + (parent.tasks.length ? (parent.tasks.reduce((h, t) => h + t.height, 0) + (parent.tasks.length - 1) * p.taskGap + 20 + p.rowGap) / 2 : 0) }, Re, p, { ...opt, idleStyle: false }, drag);
    const angles = distribute(child.nodes.filter(n => !n.parent).map(n => Math.atan2(n.y - parent.y, p.bubbleOffset) * 180 / Math.PI), p.arcFollow, 9, p.arcMax);
    let i = 0;
    for (const n of child.nodes) {
      if (!n.parent) { n.parent = parent.id; n.port = angles[i++]; n.size = ACCOUNT_NODE_SIZE; n.scale = 1; n.opacity = 1; if (n.arc) n.arc.R = ACCOUNT_NODE_SIZE / 2 + p.arcGap; }
      descendants.push(n);
    }
    parent.arc = { R: parent.size / 2 * parent.scale + p.arcGap, lo: Math.min(parent.arc?.lo ?? -14, angles[0] - p.arcPad), hi: Math.max(parent.arc?.hi ?? 14, angles.at(-1)! + p.arcPad) };
    tasks.push(...child.tasks);
  });
  nodes.push(...descendants);
  return { side, H, nodes, ear: { lo, hi }, tasks };
}

export function extentOf(w: Wing, hubX: number, Re: number) {
  let core = Re * 1.15;
  w.nodes.forEach((n) => { core = Math.max(core, Math.abs(n.x - hubX) + LABEL_W * n.scale * n.size / (NODE_R * 2) / 2); });
  let full = core;
  w.tasks.forEach((t) => { full = Math.max(full, Math.abs(t.x - hubX) + t.width); });
  return { core, full };
}

export function solve(sc: Scene, p: Params = DEFAULTS, drag: Drag | null = null): Layout {
  const vw = sc.vw, vh = sc.vh, pad = 70, m = p.margin;
  const preferredRe = Math.max(vw < 600 ? 48 : 80, Math.min(130, vw * 0.13, vh * 0.2)) * p.ringScale;
  let Re = preferredRe;
  const hasTasksIn = (e: Entity): boolean => !e.collapsed && (e.tasks.length > 0 || !!e.children?.some(hasTasksIn));
  const hasTasks = [...sc.left, ...sc.right].some(hasTasksIn);
  // Vertical: each wing compresses its own rows; whatever still overflows scrolls.
  const fitRow = (list: readonly Entity[], idleStyle: boolean) => {
    const available = vh - 2 * pad;
    const h1 = wingHeight(wingRows(list, p, { idleStyle, rowScale: 1 }), p);
    if (h1 <= available) return 1;
    const h0 = wingHeight(wingRows(list, p, { idleStyle, rowScale: 0 }), p);
    if (h0 >= available) return 0;
    let lo = 0, hi = 1;
    for (let i = 0; i < 16; i++) {
      const mid = (lo + hi) / 2;
      if (wingHeight(wingRows(list, p, { idleStyle, rowScale: mid }), p) <= available) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const optL = { idleStyle: false, rowScale: fitRow(sc.left, false), squeeze: 1 };
  const optR = { idleStyle: hasTasks, rowScale: fitRow(sc.right, hasTasks), squeeze: 1 };
  const hL = wingHeight(wingRows(sc.left, p, optL), p), hR = wingHeight(wingRows(sc.right, p, optR), p);
  const sceneH = Math.max(vh, Math.max(hL, hR) + pad * 2);
  const at = (x: number) => ({ x, y: sceneH / 2 });
  const dragOf = (side: Side) => drag && drag.side === side ? drag : null;
  // Fit the central ring first, then compress both columns by the same ratio.
  const panelWing = (wing: Wing) => {
    if (sc.panel?.side !== wing.side) return wing;
    const hidden = new Set<string>();
    for (const n of wing.nodes) {
      if (n.id === sc.panel.selected && !n.arc) n.arc = { R: n.size * n.scale / 2 + p.arcGap, lo: -14, hi: 14 };
      if (n.parent && (n.parent === sc.panel.selected || hidden.has(n.parent))) { n.opacity = 0; hidden.add(n.id); }
    }
    for (const t of wing.tasks) { t.hidden = true; t.x -= wing.side * 12; }
    return wing;
  };
  const reservePanel = !!sc.panel && !sc.panel.overlay;
  const measure = () => {
    const L = solveWing(sc.left, -1, at(0), Re, p, optL, null);
    const R = solveWing(sc.right, 1, at(0), Re, p, optR, null);
    const extent = (wing: Wing) => extentOf(reservePanel && sc.panel?.side === wing.side ? { ...panelWing(wing), nodes: wing.nodes.filter(n => n.opacity > 0), tasks: [] } : wing, 0, Re);
    return { eL: extent(L), eR: extent(R) };
  };
  let e = measure();
  const leftEdge = reservePanel && sc.panel?.side === -1 ? sc.panel.edge + 40 : m;
  const rightEdge = reservePanel && sc.panel?.side === 1 ? sc.panel.edge - 40 : vw - m;
  const avail = rightEdge - leftEdge;
  if (e.eL.full + e.eR.full > avail) {
    let lo = preferredRe * MIN_HUB_RATIO, hi = preferredRe;
    Re = lo; e = measure();
    if (e.eL.full + e.eR.full <= avail) {
      for (let i = 0; i < 24; i++) {
        Re = (lo + hi) / 2;
        const candidate = measure();
        if (candidate.eL.full + candidate.eR.full <= avail) lo = Re;
        else hi = Re;
      }
      Re = lo; e = measure();
    } else {
      let lo = p.squeezeMin, hi = 1;
      optL.squeeze = optR.squeeze = lo; e = measure();
      if (e.eL.full + e.eR.full <= avail) {
        for (let i = 0; i < 24; i++) {
          optL.squeeze = optR.squeeze = (lo + hi) / 2;
          const candidate = measure();
          if (candidate.eL.full + candidate.eR.full <= avail) lo = optL.squeeze;
          else hi = optL.squeeze;
        }
        optL.squeeze = optR.squeeze = lo; e = measure();
      }
    }
  }
  // Keep the hub at the viewport center whenever both wings fit. Only an
  // actual edge constraint may displace it, by the smallest distance needed.
  let hx = vw / 2;
  const minX = leftEdge + e.eL.full, maxX = rightEdge - e.eR.full;
  if (minX <= maxX) hx = Math.max(minX, Math.min(maxX, hx));
  else hx = reservePanel && sc.panel?.side === 1 ? maxX : minX; // A dock prioritizes its selected node; the far wing may clip.
  if (reservePanel && sc.panel?.narrow) {
    const side = sc.panel.side;
    const wing = panelWing(solveWing(side === 1 ? sc.right : sc.left, side, at(0), Re, p, side === 1 ? optR : optL, null));
    const selected = wing.nodes.find(n => n.id === sc.panel!.selected);
    if (selected) {
      const radius = selected.arc?.R ?? selected.size * selected.scale / 2 + p.arcGap;
      const stroke = 2 * Math.max(0.8, Re / 130);
      hx = sc.panel.edge - side * (radius + stroke + PANEL_ARC_GAP) - selected.x;
    }
  }
  const hub = { x: hx, y: sceneH / 2, Re, ...hubDots(sc.hubInteraction) };
  const L = panelWing(solveWing(sc.left, -1, hub, Re, p, optL, dragOf(-1)));
  const R = panelWing(solveWing(sc.right, 1, hub, Re, p, optR, dragOf(1)));
  return { vw, vh, sceneH, hub, wings: [L, R], balance: [
    { ...e.eL, squeeze: optL.squeeze },
    { ...e.eR, squeeze: optR.squeeze },
  ] };
}
