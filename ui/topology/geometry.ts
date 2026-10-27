export interface Box { x: number; y: number; width: number; height: number }
export function wirePath(parent: Box, child: Box, ring: { x: number; y: number; radius: number }, vertical: boolean, through?: number) {
  const point = (flow: number, cross: number) => vertical ? `${cross},${flow}` : `${flow},${cross}`;
  const curve = (start: number, cross: number, end: number, endCross: number) => {
    const mid = (start + end) / 2;
    return `C${point(mid, cross)} ${point(mid, endCross)} ${point(end, endCross)}`;
  };
  const af = vertical ? parent.y + parent.height : parent.x + parent.width;
  const ac = vertical ? parent.x + parent.width / 2 : parent.y + parent.height / 2;
  const bf = vertical ? child.y : child.x, bc = vertical ? child.x + child.width / 2 : child.y + child.height / 2;
  if (through === undefined) return `M${point(af, ac)} ${curve(af, ac, bf, bc)}`;
  const rf = vertical ? ring.y : ring.x, r = ring.radius;
  return `M${point(af, ac)} ${curve(af, ac, rf - r, through)} L${point(rf + r, through)} ${curve(rf + r, through, bf, bc)}`;
}
