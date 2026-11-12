import type { Point, Side } from './solve';
import { TopologyAnimator, nodeKey } from './animate';
import type { PaintNode } from './render';
import type { TopologyGroupPlan } from './compact';

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
  contact(side: Side, fraction: number) {
    const path = this.paths.get(`rail${side}`);
    if (!path?.getAttribute('d')) return undefined;
    const length = path.getTotalLength();
    return length > 0 ? path.getPointAtLength(length * Math.max(0, Math.min(1, fraction))) : undefined;
  }
  constructor(private svg: SVGSVGElement, prefix: string,
    private onHover?: (target: { side: Side; id: string } | null) => void,
    private onPointerDown?: (event: PointerEvent, target: { side: Side; id: string }) => void) {
    const defs = document.createElementNS(ns, 'defs'), gradient = document.createElementNS(ns, 'linearGradient');
    gradient.id = `${prefix}-portrait-ear`;
    gradient.setAttribute("gradientUnits", "userSpaceOnUse");
    for (const [offset, color] of [['0', 'var(--mark-agent-start)'], ['1', 'var(--mark-agent-end)']]) {
      const stop = document.createElementNS(ns, 'stop'); stop.setAttribute('offset', offset); stop.style.stopColor = color; gradient.append(stop);
    }
    defs.append(gradient); svg.append(defs); this.gradient = gradient;
  }
  private gradient: SVGLinearGradientElement;
  private path(key: string, d: string, className: string, opacity = 1, attrs: Record<string, string | number> = {}, hover?: { side: Side; id: string }, owner: { side: Side; id: string } | undefined = hover) {
    this.keep.add(key);
    let path = this.paths.get(key);
    if (!path) { path = document.createElementNS(ns, 'path'); this.paths.set(key, path); this.svg.append(path); }
    for (const [k, v] of Object.entries({ d, class: className, opacity, ...attrs })) path.setAttribute(k, String(v));
    path.onpointerdown = owner ? event => this.onPointerDown?.(event, owner) : null;
    path.onpointerenter = hover ? () => this.onHover?.(hover) : null;
    path.onpointerleave = path.onpointercancel = hover ? () => this.onHover?.(null) : null;
  }
  paint(a: TopologyAnimator, nodes: PaintNode[], openGroup?: TopologyGroupPlan & { label?: string }) {
    const h = a.values('hub'), p = a.values('portrait');
    if (!h || !p) return;
    this.keep.clear();
    // Straight ears use scene coordinates for their gradient.
    for (const [key, value] of Object.entries({ x1: h.x + p.earOffset, x2: h.x + p.earOffset + p.earHalf, y1: h.y, y2: h.y })) this.gradient.setAttribute(key, String(value));
    const point = (x: number, y: number) => ({ x, y });
    for (const side of [-1, 1] as const) {
      const wing = nodes.filter(n => n.side === side && !n.parent).map(n => a.values(nodeKey(side, n.id))).filter(v => v && v.presence > 0.01);
      const x = side === -1 ? p.sourceX : p.agentX, y = h.y;
      const earX = h.x + side * p.earOffset;
      if (wing.length) {
        const edge = side === -1 ? Math.min(...wing.map(v => v!.y), y) : Math.max(...wing.map(v => v!.y), y);
        this.path(`rail${side}`, railPath([point(earX, y), point(x, y), point(x, edge)], 26), `portrait-rail ${side === -1 ? 'left' : 'right'}`, 0.45);
        if (openGroup?.side === side && !openGroup.parent) {
          const members = nodes.filter(n => n.side === side && !n.parent && openGroup.members.includes(n.id))
            .map(n => a.live.get(nodeKey(side, n.id))?.alive ? a.values(nodeKey(side, n.id)) : undefined).filter(v => v && v.presence >= 0.02);
          if (members.length) {
            const end = side === -1 ? Math.min(...members.map(v => v!.y), y) : Math.max(...members.map(v => v!.y), y);
            // Only the open group's connection to the hub is interactive; the
            // remaining shared rail stays canvas. Reuse its visible bend.
            const radius = Math.min(26, Math.abs(earX - x) / 2, Math.abs(edge - y) / 2);
            this.path(`${openGroup.id}:rail-hit`, railPath([point(earX, y), point(x, y), point(x, end)], radius), 'topology-path-hit', 1,
              { 'aria-label': `${openGroup.label ?? openGroup.id} connection` }, undefined, { side, id: openGroup.id });
          }
        }
      }
      this.path(`ear${side}`, railPath([point(earX, y), point(earX + side * p.earHalf, y)]), `topology-ear ${side === -1 ? 'left' : 'right'}`, 1,
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
    }
    for (const [key, path] of this.paths) if (!this.keep.has(key)) { path.remove(); this.paths.delete(key); }
  }
  dispose() { this.svg.replaceChildren(); this.paths.clear(); }
}
