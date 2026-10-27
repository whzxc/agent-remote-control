export interface Box { x: number; y: number; width: number; height: number }
export function wirePath(parent: Box, child: Box, ring: { x: number; y: number; radius: number }, vertical: boolean, through?: number) {
  const point = (flow: number, cross: number) => vertical ? `${cross},${flow}` : `${flow},${cross}`;
  const af = vertical ? parent.y + parent.height : parent.x + parent.width;
  const ac = vertical ? parent.x + parent.width / 2 : parent.y + parent.height / 2;
  const bf = vertical ? child.y : child.x, bc = vertical ? child.x + child.width / 2 : child.y + child.height / 2;
  if (through === undefined) {
    const mid = (af + bf) / 2;
    return `M${point(af, ac)} C${point(mid, ac)} ${point(mid, bc)} ${point(bf, bc)}`;
  }
  const rf = vertical ? ring.y : ring.x, r = ring.radius;
  return `M${point(af, ac)} C${point(af + (rf - r - af) * .7, ac)} ${point(rf - r * 1.4, through)} ${point(rf - r, through)} L${point(rf + r, through)} C${point(rf + r * 1.4, through)} ${point(bf - (bf - rf - r) * .7, bc)} ${point(bf, bc)}`;
}
