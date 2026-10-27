import type { ArenaLayout, ArenaLoop } from './solve';
import type { TopologyAnimator } from './animate';
import { wirePath } from './geometry';
export type WireState = 'normal' | 'connecting' | 'error' | 'inactive';
const ns = 'http://www.w3.org/2000/svg';
// One SVG, stable path elements, same-frame spring coordinates. CSS owns light motion.
export class TopologyPainter {
  private paths = new Map<string, { base: SVGPathElement; light: SVGPathElement }>();
  constructor(private svg: SVGSVGElement) {}
  dispose() {
    for (const paths of this.paths.values()) { paths.base.remove(); paths.light.remove(); }
    this.paths.clear();
  }
  paint(animator: TopologyAnimator, layout: ArenaLayout, loops: ArenaLoop[], reduced: boolean) {
    const ring = animator.values('ring'); if (!ring) return;
    const vertical = layout.orientation === 'portrait', used = new Set<string>();
    const boxes = loops.flatMap(loop => loop.nodes).flatMap(node => {
      const value = animator.values(node.id);
      return value ? [{ id: node.id, x: value.x, y: value.y, width: value.width, height: value.height }] : [];
    });
    loops.forEach((loop, index) => {
      const through = (vertical ? ring.x : ring.y) + (index - (loops.length - 1) / 2) * Math.min(12, ring.radius / Math.max(1, loops.length));
      // Phase offsets make one continuous light traverse the chain, including later hops.
      const lengths = new Map<string, number>();
      const sorted = [...loop.edges].sort((a, b) => loop.nodes.find(n => n.id === a.from)!.depth - loop.nodes.find(n => n.id === b.from)!.depth);
      for (const edge of sorted) {
        const p = animator.values(edge.from), n = animator.values(edge.to);
        if (!p || !n) continue;
        used.add(edge.id);
        let paths = this.paths.get(edge.id);
        if (!paths) {
          const base = document.createElementNS(ns, 'path'), light = document.createElementNS(ns, 'path');
          base.setAttribute('pathLength', '1'); base.setAttribute('fill', 'none'); light.setAttribute('fill', 'none');
          base.setAttribute('stroke-width', '2'); light.setAttribute('stroke-width', '3');
          light.setAttribute('stroke-linecap', 'round'); light.setAttribute('class', 'activity-flow');
          this.svg.append(base, light); paths = { base, light }; this.paths.set(edge.id, paths);
        }
        const d = wirePath({ x: p.x, y: p.y, width: p.width, height: p.height }, { x: n.x, y: n.y, width: n.width, height: n.height },
          { x: ring.x, y: ring.y, radius: ring.radius }, vertical, edge.throughRing ? through : undefined,
          vertical ? { gutter: loop.color % 2 ? layout.width - 12 : 12, obstacles: boxes.filter(box => box.id !== edge.from && box.id !== edge.to) } : undefined);
        paths.base.setAttribute('stroke-dasharray', `${Math.max(0, Math.min(1, n.draw ?? 1))} 1`);
        paths.base.setAttribute('d', d); paths.light.setAttribute('d', d);
        paths.base.setAttribute('stroke', `var(--chart-${loop.color + 1})`);
        const opacity = Math.min(p.opacity, n.opacity);
        paths.base.setAttribute('opacity', String(opacity * (loop.lingering ? .2 : .45)));
        paths.light.setAttribute('stroke', edge.state === 'waiting' ? 'var(--warning)' : `var(--chart-${loop.color + 1})`);
        paths.light.setAttribute('opacity', String(opacity));
        paths.light.style.display = reduced || edge.state === 'ended' ? 'none' : '';
        paths.light.dataset.waiting = String(edge.state === 'waiting');
        const offset = lengths.get(edge.from) ?? 0;
        paths.light.style.animationDelay = `${-offset / 80}s`;
        try { lengths.set(edge.to, offset + paths.base.getTotalLength()); } catch { /* SVG geometry is unavailable in nonvisual renderers. */ }
      }
    });
    for (const [id, paths] of this.paths) if (!used.has(id)) { paths.base.remove(); paths.light.remove(); this.paths.delete(id); }
  }
}
