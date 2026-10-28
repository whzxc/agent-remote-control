import { deg, type Side, type Layout, type Point } from "./solve";
import { arcPath, grownWire, tentacle, finitePoints } from "./geometry";
import { TopologyAnimator, nodeKey, taskKey } from "./animate";
import type { SurfaceRect } from "../motion/surface";

export type WireState = "normal" | "connecting" | "error" | "inactive";
export type TaskState = import("../state/taskProjection").TaskState | "summary";
export interface PaintNode { id: string; side: Side; parent?: string; state: WireState; attention: boolean; selected: boolean; label?: string }
export interface PaintTask { id: string; parent: string; side: Side; state: TaskState; selected: boolean }
const ns = "http://www.w3.org/2000/svg";
function element<K extends keyof SVGElementTagNameMap>(tag: K, parent: SVGElement, attrs: Record<string, string> = {}) {
  const el = document.createElementNS(ns, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  parent.append(el); return el;
}
const attr = (el: SVGElement, attrs: Record<string, string | number>) => {
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
};
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

// Owns a single SVG subtree. React owns HTML contents; both consume the same frame.
export class TopologyPainter {
  private groups = new Map<string, { group: SVGGElement; outline: SVGPathElement; flow: SVGPathElement; gap: SVGPathElement;
    arc: SVGPathElement; hit: SVGPathElement; arcHit: SVGPathElement; gradient: SVGLinearGradientElement; solid: SVGStopElement; fade: SVGStopElement; end: SVGStopElement }>();
  private ears = new Map<Side, SVGPathElement>();
  private sequence = 0;
  private guides: SVGGElement | null = null;
  constructor(readonly svg: SVGSVGElement, readonly prefix: string,
    readonly onHover?: (target: { side: Side; id: string; task?: boolean } | null) => void) {}
  private branch(key: string) {
    let branch = this.groups.get(key);
    if (branch) return branch;
    const group = element("g", this.svg), defs = element("defs", group);
    const gradient = element("linearGradient", defs, { id: `${this.prefix}-${++this.sequence}`, gradientUnits: "userSpaceOnUse" });
    element("stop", gradient, { offset: "0", "stop-opacity": "1" });
    const solid = element("stop", gradient, { "stop-opacity": "1" }), fade = element("stop", gradient), end = element("stop", gradient, { offset: "1" });
    const outline = element("path", group), flow = element("path", group), gap = element("path", group), arc = element("path", group);
    const hit = element("path", group, { class: "topology-path-hit" }), arcHit = element("path", group, { class: "topology-path-hit" });
    const [kind, side, id] = JSON.parse(key) as [string, Side, string];
    for (const target of [hit, arcHit]) {
      target.onpointerenter = () => this.onHover?.({ side, id, task: kind === "task" });
      target.onpointerleave = target.onpointercancel = () => this.onHover?.(null);
    }
    branch = { group, outline, flow, gap, arc, hit, arcHit, gradient, solid, fade, end };
    this.groups.set(key, branch); return branch;
  }
  paint(animator: TopologyAnimator, nodes: PaintNode[], tasks: PaintTask[], panel: SurfaceRect | null, debug: Layout | null = null) {
    const h = animator.values("hub");
    if (!h) return;
    const p = animator.values("shape")!, scale = h.Re / 130, keep = new Set<string>();
    this.guides?.replaceChildren();
    if (debug && !this.guides) this.guides = element("g", this.svg, { class: "topology-guides" });
    const controls = (end: Point, c1: Point, c2: Point, port: Point) => {
      if (!debug || !finitePoints(end, c1, c2, port)) return;
      element("path", this.guides!, { d: `M${end.x},${end.y} L${c1.x},${c1.y} M${c2.x},${c2.y} L${port.x},${port.y}`, class: "guide-tangent" });
      for (const point of [c1, c2]) element("circle", this.guides!, { cx: String(point.x), cy: String(point.y), r: "3" });
    };
    for (const n of nodes) {
      const key = nodeKey(n.side, n.id), v = animator.values(key);
      if (!v) continue;
      keep.add(key);
      const b = this.branch(key), a = deg(v.port), radial = { x: n.side * Math.cos(a), y: Math.sin(a) };
      const ancestor = n.parent ? animator.values(nodeKey(n.side, n.parent)) : undefined;
      const port = ancestor ? { x: ancestor.x + ancestor.radius * radial.x, y: ancestor.y + ancestor.radius * radial.y }
        : { x: h.x + h.Re * radial.x, y: h.y + h.Re * radial.y };
      const start = { x: v.x - n.side * (v.size / 2 * v.scale + 6), y: v.y }, D = Math.hypot(start.x - port.x, start.y - port.y);
      const c1 = { x: start.x - n.side * D * p.t1Node, y: start.y };
      const c2 = { x: port.x + radial.x * D * p.t1Root, y: port.y + radial.y * D * p.t1Root };
      const shape = ancestor ? tentacle(start, port, radial, n.side, scale, { t2End: p.t2End, t2Root: p.t2Root, flare: p.flare }, n.state === "connecting")
        : { ...grownWire(start, c1, c2, port, scale, p.flare, false, n.state === "connecting"), c1, c2 };
      if (n.state !== "inactive") controls(start, shape.c1, shape.c2, port);
      attr(b.group, { class: `topology-branch primary ${n.side === 1 ? "right" : "left"}`, "data-state": n.state,
        "data-selected": String(n.selected),
        opacity: v.presence });
      attr(b.gradient, { x1: port.x, y1: port.y, x2: start.x, y2: start.y });
      attr(b.solid, { offset: Math.min(0.29, 10 * scale / Math.max(1, D)) });
      attr(b.fade, { offset: n.state === "connecting" ? Math.min(1, 26 * scale / Math.max(1, D)) : 0.3,
        "stop-opacity": n.state === "connecting" ? 0 : 0.7 });
      attr(b.end, { "stop-opacity": n.state === "connecting" ? 0 : n.side === 1 ? 0.42 : 0.32 });
      attr(b.outline, { d: shape.outline, fill: `url(#${b.gradient.id})`, opacity: v.availability * clamp(v.wireOpacity + 0.12 * clamp(v.emphasis, 0, 1), 0, 1) });
      attr(b.flow, { class: "connecting-wire", d: n.state === "connecting" ? shape.centerline : "", "stroke-width": 3 * scale });
      attr(b.gap, { class: "wire-break", d: n.state === "error" ? shape.gap : "", "stroke-width": 18 * scale });
      attr(b.arc, { class: `topology-outer-arc ${n.attention ? "needs-attention" : ""}`,
        d: arcPath(v.x, v.y, v.radius, v.alo, v.ahi, n.side), opacity: v.aop, "stroke-width": (4 + 0.5 * clamp(v.emphasis, 0, 1)) * Math.max(0.8, scale) });
      const interactive = animator.live.get(key)?.alive && v.presence >= 0.02;
      attr(b.hit, { d: !interactive || n.state === "inactive" ? "" : shape.centerline, "aria-label": `${n.label ?? n.id} connection` });
      attr(b.arcHit, { d: !interactive || v.aop < 0.02 ? "" : arcPath(v.x, v.y, v.radius, v.alo, v.ahi, n.side), "aria-label": `${n.label ?? n.id} arc` });
    }
    const bridges: PaintTask[] = panel ? nodes.filter(n => n.selected).map(n => ({
      id: `panel:${n.id}`, parent: n.id, side: n.side, state: "running" as const, selected: true,
    })) : [];
    for (const t of [...tasks, ...bridges]) {
      const key = taskKey(t.side, t.id), n = animator.values(nodeKey(t.side, t.parent));
      const bridge = bridges.includes(t);
      const v = bridge && n ? { x: n.x, y: n.y, port: 0, op: 1, bodyOpacity: 0.62, emphasis: n.emphasis } : animator.values(key);
      if (!v || !n) continue;
      keep.add(key);
      const b = this.branch(key), a = deg(v.port), radial = { x: t.side * Math.cos(a), y: Math.sin(a) };
      const port = { x: n.x + n.radius * radial.x, y: n.y + n.radius * radial.y };
      const end = bridge && panel ? { x: t.side === 1 ? panel.x : panel.x + panel.width,
        y: clamp(v.y, panel.y + 27, panel.y + panel.height - 27) } : { x: v.x + ((t.side === -1 ? 1 : 0) - (v.anchor ?? 0)) * (v.width ?? 0), y: v.y };
      const shape = tentacle(end, port, radial, t.side, scale, { t2End: p.t2End, t2Root: p.t2Root, flare: p.flare });
      controls(end, shape.c1, shape.c2, port);
      attr(b.group, { class: `topology-branch secondary ${bridge ? "panel-link" : ""} ${t.side === 1 ? "right" : "left"}`, "data-state": t.state,
        opacity: v.op });
      attr(b.outline, { d: shape.outline, class: "task-body",
        style: `opacity:${v.bodyOpacity + 0.1 * clamp(v.emphasis, 0, 1)}` });
      attr(b.hit, { d: bridge || !animator.live.get(key)?.alive || v.op < 0.02 ? "" : shape.centerline, "aria-label": `${t.id} connection` });
      attr(b.flow, { d: t.state === "running" ? shape.centerline : "", class: "activity-flow" });
    }
    for (const [key, b] of this.groups) if (!keep.has(key)) { b.group.remove(); this.groups.delete(key); }
    for (const side of [-1, 1] as const) {
      let ear = this.ears.get(side);
      if (!ear) { ear = element("path", this.svg, { class: `topology-ear ${side === 1 ? "right" : "left"}` }); this.ears.set(side, ear); }
      const v = animator.values(`ear${side}`)!;
      attr(ear, { d: arcPath(h.x, h.y, h.Re, v.lo, v.hi, side), "stroke-width": 14 * scale, opacity: 1 });
      this.svg.append(ear); // caps cover the roots after additions as well
    }
    if (debug) {
      const g = this.guides!, height = animator.values("scene")!.height, middle = debug.vw / 2;
      const line = (x1: number, y1: number, x2: number, y2: number, name = "") =>
        [x1, y1, x2, y2].every(Number.isFinite) && element("path", g, { d: `M${x1},${y1} L${x2},${y2}`, class: name });
      const label = (x: number, y: number, text: string, anchor = "middle") => {
        element("text", g, { x: String(x), y: String(y), "text-anchor": anchor }).textContent = text;
      };
      line(middle, 0, middle, height, "guide-midline");
      line(h.x, 0, h.x, height, "guide-hubline");
      const y = Math.max(22, h.y - h.Re - 38);
      line(middle, y, h.x, y);
      label((middle + h.x) / 2, y - 8, `Δx ${(h.x - middle).toFixed(1)} px`);
      for (const [index, side] of ([-1, 1] as const).entries()) {
        const b = debug.balance[index], edge = h.x + side * b.full;
        line(h.x, y + 24, edge, y + 24, side === -1 ? "guide-left" : "guide-right");
        line(edge, y + 18, edge, y + 30);
        label(h.x + side * 18, y + 46, `${side === -1 ? "L" : "R"} ${b.full.toFixed(1)} px · ×${b.squeeze.toFixed(2)}`, side === -1 ? "end" : "start");
      }
      this.svg.append(g);
    }
  }
  dispose() { this.svg.replaceChildren(); this.groups.clear(); this.ears.clear(); this.guides = null; }
}
