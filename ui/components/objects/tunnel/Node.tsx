import { useLayoutEffect, useRef, type Ref } from 'react';
import { TopologyAnimator } from '../../../topology/animate';
import type { ArenaLayout } from '../../../topology/solve';
import { TopologyPainter } from '../../../topology/render';

// The object preview uses the same arena wires as the homepage.
export function TunnelNode({ svgRef, frame }: { svgRef?: Ref<SVGSVGElement>; frame?: { layout: ArenaLayout } }) {
  const local = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (!frame || !local.current) return;
    const animator = new TopologyAnimator(), { layout } = frame;
    animator.target('ring', layout.ring);
    for (const loop of layout.loops) for (const node of loop.nodes) animator.target(node.id, { x: node.x, y: node.y, width: node.width, height: node.height, opacity: 1 });
    const painter = new TopologyPainter(local.current);
    painter.paint(animator, layout, layout.loops, true);
    return () => painter.dispose();
  }, [frame]);
  return <svg ref={svgRef ?? local} className="topology-wires" aria-hidden="true" />;
}
