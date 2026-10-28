import type { PaintNode, PaintTask } from "./render.ts";
import { DEFAULTS, type Drag, type Layout, type Side } from "./solve.ts";

export const nodeKey = (side: Side, id: string) => JSON.stringify(["node", side, id]);
export const taskKey = (side: Side, id: string) => JSON.stringify(["task", side, id]);
type Field = { x: number; v: number; t: number; pin?: number };
export interface Primitive {
  fields: Record<string, Field>;
  alive: boolean;
  parent?: string;
  side?: Side;
}
// Each mounted scene owns its springs and clock. Geometry is never sampled from DOM.
export class TopologyAnimator {
  readonly live = new Map<string, Primitive>();
  params: typeof DEFAULTS;
  private orientationRemaining = 0;
  constructor(params = DEFAULTS) { this.params = params; }
  private spring(key: string, targets: Record<string, number>, spawn: Record<string, number> = {}) {
    let s = this.live.get(key);
    if (!s) { s = { fields: {}, alive: true }; this.live.set(key, s); }
    s.alive = true;
    for (const [name, target] of Object.entries(targets)) {
      const f = s.fields[name] ??= { x: spawn[name] ?? target, v: 0, t: target };
      f.t = target; f.pin = undefined;
    }
    return s;
  }
  setTargets(layout: Layout, drag: Drag | null = null) {
    const nextOrientation = layout.portrait ? 1 : 0;
    const previousOrientation = this.live.get('orientation')?.fields.portrait?.t;
    if (previousOrientation !== undefined && previousOrientation !== nextOrientation) this.orientationRemaining = 0.36;
    this.live.forEach(s => { s.alive = false; });
    this.spring("hub", { dotSource: 1, dotAgent: 1, ...layout.hub, rotation: 0 });
    this.spring('orientation', { portrait: layout.portrait ? 1 : 0 });
    if (layout.portrait) this.spring("portrait", { ...layout.portrait });
    else if (this.live.has('portrait')) this.live.get('portrait')!.alive = true;
    this.spring("scene", { height: layout.sceneH });
    const { t1Node, t1Root, t2End, t2Root, flare } = this.params;
    this.spring("shape", { t1Node, t1Root, t2End, t2Root, flare });
    for (const w of layout.wings) {
      this.spring(`ear${w.side}`, w.ear);
      for (const n of w.nodes) {
        const parent = n.parent ? this.values(nodeKey(w.side, n.parent)) : undefined;
        const s = this.spring(nodeKey(w.side, n.id), { x: n.x, y: n.y, size: n.size, scale: n.scale, op: n.opacity, port: n.port,
          taskBusX: n.taskBusX ?? n.x, childBusX: n.childBusX ?? n.x, radius: n.arc?.R ?? n.size / 2 * n.scale + this.params.arcGap, alo: n.arc?.lo ?? 0, ahi: n.arc?.hi ?? 0, aop: n.arc ? 1 : 0, presence: n.opacity === 0 ? 0 : 1, wireOpacity: n.dim ? 0.3 : 0.78, availability: 1, emphasis: 0 },
        { aop: 0, alo: 0, ahi: 0, ...(parent ? { x: parent.x + (layout.portrait ? -w.side : w.side) * parent.radius, y: parent.y, op: 0, presence: 0, scale: 0.6 } : {}) });
        s.side = w.side; s.parent = n.parent ? nodeKey(w.side, n.parent) : undefined;
        if (drag?.kind === "node" && drag.side === w.side && drag.id === n.id) {
          s.fields.x.pin = drag.x; s.fields.y.pin = drag.y;
        }
      }
      for (const t of w.tasks) {
        const parent = t.parentTaskId ? taskKey(w.side, t.parentTaskId) : nodeKey(w.side, t.parent), n = this.values(parent)!;
        const s = this.spring(taskKey(w.side, t.id), { x: t.x, y: t.y, width: t.width, height: t.height, anchor: t.anchor ?? (t.side === -1 ? 1 : 0), port: t.port, op: t.hidden ? 0 : 1, bodyOpacity: 0.62, emphasis: 0 },
          { x: n.x + (layout.portrait ? -t.side : t.side) * (n.radius ?? 0), y: n.y + (n.height ?? 0) / 2, port: 0, op: 0 });
        s.parent = parent; s.side = w.side;
        if (drag?.kind === "task" && drag.side === w.side && drag.id === t.id) {
          s.fields.x.pin = drag.x; s.fields.y.pin = drag.y;
        }
      }
    }
    for (const [key, s] of this.live) {
      if (s.alive) continue;
      if (!s.parent) { this.live.delete(key); continue; }
      s.fields.op.t = 0; s.fields.port.t = 0;
      if (s.fields.presence) s.fields.presence.t = 0;
      s.fields.x.pin = s.fields.y.pin = undefined;
    }
  }
  appearance(nodes: PaintNode[], tasks: PaintTask[]) {
    for (const node of nodes) {
      const fields = this.live.get(nodeKey(node.side, node.id))?.fields;
      if (!fields) continue;
      fields.availability.t = node.state === 'inactive' ? 0 : 1;
      if (node.selected) fields.wireOpacity.t = 1;
    }
    for (const task of tasks) {
      const fields = this.live.get(taskKey(task.side, task.id))?.fields;
      if (fields) fields.bodyOpacity.t = task.state === 'done' ? 0.25 : 0.62;
    }
  }
  highlight(nodes: Set<string> | null) {
    for (const [key, primitive] of this.live) {
      if (!primitive.fields.emphasis) continue;
      const [kind, side, id] = JSON.parse(key) as [string, Side, string];
      const lit = primitive.alive && !!nodes?.has(kind === 'task' ? key : JSON.stringify([side, id]));
      primitive.fields.emphasis.t = lit ? 1 : 0;
    }
  }
  values(key: string) {
    const s = this.live.get(key);
    return s ? Object.fromEntries(Object.entries(s.fields).map(([key, f]) => [key, f.x])) : undefined;
  }
  step(dt: number, reduced = false) {
    let moving = false;
    const morphing = this.orientationRemaining > 0;
    this.orientationRemaining = reduced ? 0 : Math.max(0, this.orientationRemaining - dt);
    const direct = reduced || morphing && this.orientationRemaining === 0;
    const k = morphing ? 520 : this.params.stiffness, c = morphing ? 42 : this.params.damping;
    for (const [key, s] of this.live) {
      if (!s.alive && s.parent) {
        const n = this.values(s.parent);
        if (n) { s.fields.x.t = n.x + (this.live.get("orientation")!.fields.portrait.t ? -s.side! : s.side!) * (n.radius ?? 0); s.fields.y.t = n.y + (n.height ?? 0) / 2; }
      }
      for (const f of Object.values(s.fields)) {
        if (f.pin !== undefined || direct) { f.x = f.pin ?? f.t; f.v = 0; continue; }
        const sub = Math.max(1, Math.ceil(dt / 0.008)), h = dt / sub;
        for (let i = 0; i < sub; i++) { f.v += (-k * (f.x - f.t) - c * f.v) * h; f.x += f.v * h; }
        if (Math.abs(f.x - f.t) > 0.01 || Math.abs(f.v) > 0.01) moving = true;
        else { f.x = f.t; f.v = 0; }
      }
      if (!s.alive && s.fields.op.x < 0.02) this.live.delete(key);
    }
    return moving;
  }
}
