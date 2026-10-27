export interface Box { x: number; y: number; width: number; height: number }
export function wirePath(parent: Box, child: Box, ring: { x: number; y: number; radius: number }, vertical: boolean, through?: number, route?: { obstacles: Box[]; gutter: number }) {
  const point = (flow: number, cross: number) => vertical ? `${cross},${flow}` : `${flow},${cross}`;
  const af = vertical ? parent.y + parent.height : parent.x + parent.width;
  const ac = vertical ? parent.x + parent.width / 2 : parent.y + parent.height / 2;
  const bf = vertical ? child.y : child.x, bc = vertical ? child.x + child.width / 2 : child.y + child.height / 2;
  const blocked = (start: number, end: number) => vertical && route?.obstacles.some(box => box.y >= start && box.y + box.height <= end);
  // Wrapped rows share a depth. Route past intervening cards in the margin so
  // a wire cannot imply that one sibling dispatched another.
  const bypass = (start: number, cross: number, end: number, endCross: number) => {
    const gutter = route!.gutter;
    return `C${point(start + 8, cross)} ${point(start + 8, gutter)} ${point(start + 16, gutter)} L${point(end - 16, gutter)} C${point(end - 8, gutter)} ${point(end - 8, endCross)} ${point(end, endCross)}`;
  };
  if (through === undefined) {
    if (blocked(af, bf)) return `M${point(af, ac)} ${bypass(af, ac, bf, bc)}`;
    const mid = (af + bf) / 2;
    return `M${point(af, ac)} C${point(mid, ac)} ${point(mid, bc)} ${point(bf, bc)}`;
  }
  const rf = vertical ? ring.y : ring.x, r = ring.radius;
  const before = blocked(af, rf - r) ? bypass(af, ac, rf - r, through) : `C${point(af + (rf - r - af) * .7, ac)} ${point(rf - r * 1.4, through)} ${point(rf - r, through)}`;
  const after = blocked(rf + r, bf) ? bypass(rf + r, through, bf, bc) : `C${point(rf + r * 1.4, through)} ${point(bf - (bf - rf - r) * .7, bc)} ${point(bf, bc)}`;
  return `M${point(af, ac)} ${before} L${point(rf + r, through)} ${after}`;
}
