import type { Point, Side } from './solve';
import { TopologyAnimator, nodeKey, taskKey } from './animate';
import type { PaintNode, PaintTask } from './render';
import type { SurfaceRect } from '../motion/surface';
import { portraitSourcePanelRoute, type PortraitLabel, type PortraitLabels } from './portrait';

const labelMeasurements = new WeakMap<HTMLElement, { signature: string; label: PortraitLabel }>();
// Measure intrinsic CSS dimensions, not the animated node transform or the
// previous viewport's clipped label. The temporary styles never reach a frame.
function measureLabel(element: HTMLElement): PortraitLabel {
  const style = getComputedStyle(element);
  const signature = [element.textContent, style.font, style.letterSpacing, style.padding].join('|');
  const cached = labelMeasurements.get(element);
  if (cached?.signature === signature) return cached.label;
  const original = element.style.cssText;
  element.style.width = 'max-content'; element.style.maxWidth = 'none'; element.style.whiteSpace = 'nowrap';
  const width = element.offsetWidth + 1, height = element.offsetHeight;
  const lineHeight = parseFloat(style.lineHeight) || height;
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) || 0;
  element.style.whiteSpace = 'normal';
  let lo = Math.ceil(width / 2), hi = width;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    element.style.maxWidth = `${mid}px`;
    if (element.offsetHeight <= 2 * lineHeight + verticalPadding) hi = mid;
    else lo = mid + 1;
  }
  element.style.cssText = original;
  const label = { width, twoLineWidth: lo, height };
  labelMeasurements.set(element, { signature, label });
  return label;
}
export function measurePortraitLabels(nodes: PaintNode[], element: (node: PaintNode) => HTMLElement | undefined): PortraitLabels {
  const left = new Map<string, PortraitLabel>(), right = new Map<string, PortraitLabel>();
  for (const node of nodes) {
    const host = element(node);
    const name = host?.querySelector<HTMLElement>('.graph-node-name');
    if (!name) continue;
    const label = measureLabel(name), chip = host?.querySelector<HTMLElement>('.agent-auto-compact');
    const sub = chip && measureLabel(chip);
    (node.side === -1 ? left : right).set(node.id, {
      width: Math.max(label.width, sub?.width ?? 0), twoLineWidth: Math.max(label.twoLineWidth, sub?.twoLineWidth ?? 0),
      height: label.height + (sub ? sub.height + 5 : 0),
    });
  }
  return { left, right };
}

// Rounded orthogonal polyline. Corners clamp to their adjacent segments, so
// short stubs and temporarily coincident animated points remain finite.
export function railPath(points: Point[], radius = 10): string {
  const run = points.filter((p, i) => i === 0 || p.x !== points[i - 1].x || p.y !== points[i - 1].y);
  if (!run.length || run.some(p => !Number.isFinite(p.x) || !Number.isFinite(p.y))) return '';
  let path = `M${run[0].x},${run[0].y}`;
  for (let i = 1; i < run.length; i++) {
    const a = run[i - 1], b = run[i], c = run[i + 1];
    if (!c) { path += ` L${b.x},${b.y}`; break; }
    const before = Math.hypot(b.x - a.x, b.y - a.y), after = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, before / 2, after / 2);
    path += ` L${b.x + (a.x - b.x) * r / before},${b.y + (a.y - b.y) * r / before}`;
    path += ` Q${b.x},${b.y} ${b.x + (c.x - b.x) * r / after},${b.y + (c.y - b.y) * r / after}`;
  }
  return path;
}
const ns = 'http://www.w3.org/2000/svg';
export class PortraitPainter {
  private paths = new Map<string, SVGPathElement>();
  private keep = new Set<string>();
  constructor(private svg: SVGSVGElement, prefix: string,
    private onHover?: (target: { side: Side; id: string; task?: boolean } | null) => void) {
    const defs = document.createElementNS(ns, 'defs'), gradient = document.createElementNS(ns, 'linearGradient');
    gradient.id = `${prefix}-portrait-ear`;
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    for (const [offset, color] of [['0', 'var(--mark-agent-start)'], ['1', 'var(--mark-agent-end)']]) {
      const stop = document.createElementNS(ns, 'stop'); stop.setAttribute('offset', offset); stop.style.stopColor = color; gradient.append(stop);
    }
    defs.append(gradient); svg.append(defs); this.gradient = gradient;
  }
  private gradient: SVGLinearGradientElement;
  private path(key: string, d: string, className: string, opacity = 1, attrs: Record<string, string | number> = {}, hover?: { side: Side; id: string; task?: boolean }) {
    this.keep.add(key);
    let path = this.paths.get(key);
    if (!path) { path = document.createElementNS(ns, 'path'); this.paths.set(key, path); this.svg.append(path); }
    for (const [k, v] of Object.entries({ d, class: className, opacity, ...attrs })) path.setAttribute(k, String(v));
    path.onpointerenter = hover ? () => this.onHover?.(hover) : null;
    path.onpointerleave = path.onpointercancel = hover ? () => this.onHover?.(null) : null;
  }
  paint(a: TopologyAnimator, nodes: PaintNode[], tasks: PaintTask[], panel: SurfaceRect | null) {
    const h = a.values('hub'), p = a.values('portrait');
    if (!h || !p) return;
    this.keep.clear();
    // Horizontal stroked paths have a zero-height object bounding box.
    for (const [key, value] of Object.entries({ x1: h.x - p.earHalf, x2: h.x + p.earHalf, y1: h.y + p.earOffset, y2: h.y + p.earOffset })) this.gradient.setAttribute(key, String(value));
    const point = (x: number, y: number) => ({ x, y });
    for (const side of [-1, 1] as const) {
      const wing = nodes.filter(n => n.side === side && !n.parent).map(n => a.values(nodeKey(side, n.id))).filter(v => v && v.presence > 0.01);
      const x = side === -1 ? p.sourceX : p.agentX, y = h.y + side * p.earOffset;
      const edge = side === -1 ? Math.min(...wing.map(v => v!.y), y) : Math.max(...wing.map(v => v!.y), y);
      this.path(`rail${side}`, railPath([point(h.x + side * p.earHalf, y), point(x, y), point(x, edge)], 26), `portrait-rail ${side === -1 ? 'left' : 'right'}`, 0.45);
      this.path(`ear${side}`, railPath([point(h.x - p.earHalf, y), point(h.x + p.earHalf, y)]), `topology-ear ${side === -1 ? 'left' : 'right'}`, 1,
        { 'stroke-width': 14 * h.Re / 130, ...(side === 1 ? { style: `stroke:url(#${this.gradient.id})` } : {}) });
    }
    for (const node of nodes) {
      const key = nodeKey(node.side, node.id), n = a.values(key);
      if (!n) continue;
      const sideClass = node.side === -1 ? 'left' : 'right';
      const opacity = n.presence * (0.2 + 0.35 * n.availability + 0.3 * n.emphasis);
      const descendants = nodes.filter(c => c.parent === node.id && c.side === node.side).map(c => ({ node: c, value: a.values(nodeKey(c.side, c.id)) })).filter(c => c.value);
      if (descendants.length) {
        const bx = n.childBusX, start = point(n.x - node.side * (n.size * n.scale / 2 + 4), n.y);
        const branches = descendants.map(child => {
          const v = child.value!;
          return { ...child, d: railPath([start, point(bx, n.y), point(bx, v.y), point(v.x + node.side * (v.size * v.scale / 2 + 4), v.y)]) };
        });
        // Paint shared stems once; each route rounds both ends of the fork.
        this.path(`${key}:account-branches`, branches.filter(c => c.value!.presence > 0.01).map(c => c.d).join(' '), `portrait-rail ${sideClass}`, opacity * Math.max(...descendants.map(c => c.value!.presence)));
        for (const { node: child, value: v, d } of branches) {
          this.path(`${key}:${child.id}:hit`, v!.presence >= 0.02 && a.live.get(nodeKey(node.side, child.id))?.alive ? d : '', 'topology-path-hit', v!.presence, {}, { side: node.side, id: child.id });
        }
      }
      const own = tasks.filter(t => t.side === node.side && t.parent === node.id && !t.parentTaskId).map(t => ({ task: t, value: a.values(taskKey(t.side, t.id)) })).filter(t => t.value);
      if (own.length) {
        const bx = n.taskBusX, start = point(n.x - n.size * n.scale / 2 - 4, n.y);
        const branches = own.map(({ task, value }) => {
          const v = value!, end = point(v.x + (1 - v.anchor) * v.width, v.y);
          const join = point(bx + Math.sign(end.x - bx) * Math.min(20, Math.abs(end.x - bx) / 2), v.y);
          const route = [start, point(bx, n.y), point(bx, v.y), join];
          return { task, v, branch: railPath(route), stub: railPath([join, end]), hit: railPath([...route, end]) };
        });
        const visible = Math.max(...own.map(t => t.value!.op));
        // Each branch rounds both junctions and ends horizontally at the exact
        // start of its status stub. A separate straight bus would cut the curves.
        this.path(`${key}:task-bus`, branches.filter(b => b.v.op > 0.01).map(b => b.branch).join(' '), `portrait-rail ${sideClass}`, opacity * visible);
        for (const { task, v, stub: d, hit } of branches) {
          const tk = taskKey(task.side, task.id);
          this.path(tk, d, `portrait-task ${sideClass}`, v.op, { 'data-state': task.state });
          this.path(`${tk}:flow`, task.state === 'running' ? d : '', `portrait-task activity-flow ${sideClass}`, v.op, { 'data-state': task.state });
          this.path(`${tk}:hit`, v.op > 0.02 && a.live.get(tk)?.alive ? hit : '', 'topology-path-hit', v.op, {}, { side: task.side, id: task.id, task: true });
        }
      }
      if (panel && node.selected) {
        const end = point(panel.x + panel.width, Math.max(panel.y + 27, Math.min(panel.y + panel.height - 27, n.y)));
        const start = point(n.x - node.side * (n.size * n.scale / 2 + 4), n.y);
        const route = node.side === 1 ? [start, point(n.childBusX, n.y), point(n.childBusX, end.y), end]
          : portraitSourcePanelRoute({ x: n.x, y: n.y, size: n.size, scale: n.scale }, panel);
        this.path(`${key}:panel`, railPath(route), `portrait-rail ${sideClass}`, 0.9);
      }
    }
    for (const task of tasks.filter(task => task.parentTaskId)) {
      const key = taskKey(task.side, task.id), child = a.values(key), parent = a.values(taskKey(task.side, task.parentTaskId!));
      if (!child || !parent) continue;
      const start = point(parent.x + (1 - parent.anchor) * parent.width - 12, parent.y + parent.height / 2);
      const end = point(child.x + (1 - child.anchor) * child.width, child.y);
      const d = railPath([start, point(start.x, end.y), end]);
      const opacity = Math.min(child.op, parent.op), sideClass = task.side === 1 ? 'right' : 'left';
      this.path(key, d, `portrait-task ${sideClass}`, opacity, { 'data-state': task.state });
      this.path(`${key}:flow`, task.state === 'running' ? d : '', `portrait-task activity-flow ${sideClass}`, opacity, { 'data-state': task.state });
      this.path(`${key}:hit`, opacity > 0.02 && a.live.get(key)?.alive ? d : '', 'topology-path-hit', opacity, {}, { side: task.side, id: task.id, task: true });
    }
    for (const [key, path] of this.paths) if (!this.keep.has(key)) { path.remove(); this.paths.delete(key); }
  }
  dispose() { this.svg.replaceChildren(); this.paths.clear(); }
}
