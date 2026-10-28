import type { Point } from './model.ts';
export interface PetSize { width: number; height: number; tagHeight: number }
export interface Rect extends Point { width: number; height: number }
export interface PetBounds extends Point { top: number }
export function petSize(kind: 'participant' | 'task' | 'preview', tagged = false): PetSize {
  const scale = kind === 'participant' ? .5 : kind === 'task' ? .5 * .6 : .375;
  return { width: 192 * scale, height: 208 * scale, tagHeight: tagged ? 18 : 0 };
}
export function boundPet(point: Point, width: number, height: number, top = 0, size = petSize('participant')): Point {
  return { x: Math.max(0, Math.min(Math.max(0, width - size.width), point.x)),
    y: Math.max(top, Math.min(Math.max(top, height - size.height - size.tagHeight), point.y)) };
}
export function overlaps(a: Rect, b: Rect) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
// Bounds include the node icon and measured labels. Prefer the hub-facing side;
// slide along obstacle edges before conceding that no non-overlapping post fits.
export function participantPost(node: Rect, hub: Point, obstacles: Rect[], bounds: PetBounds, size: PetSize): Point | undefined {
  const gap = 12, height = size.height + size.tagHeight;
  const right = hub.x >= node.x + node.width / 2;
  const preferredX = right ? node.x + node.width + gap : node.x - size.width - gap;
  const otherX = right ? node.x - size.width - gap : node.x + node.width + gap;
  const y = node.y + node.height / 2 - height / 2;
  const blocked = [node, ...obstacles];
  const candidates = [preferredX, otherX, node.x + (node.width - size.width) / 2].flatMap(x =>
    [y, ...blocked.flatMap(r => [r.y - height - gap, r.y + r.height + gap])].map(y => boundPet({ x, y }, bounds.x, bounds.y, bounds.top, size)));
  candidates.sort((a, b) => Math.abs(a.x - preferredX) + Math.abs(a.y - y) - Math.abs(b.x - preferredX) - Math.abs(b.y - y));
  return candidates.find(p => p.x + size.width <= bounds.x && p.y + height <= bounds.y &&
    blocked.every(r => !overlaps({ ...p, width: size.width, height }, r)));
}
export function bubbleEnd(frame: { x: number; y: number; width: number; height: number; anchor: number }): Point {
  return { x: frame.x + (1 - frame.anchor) * frame.width, y: frame.y + frame.height / 2 };
}
export function taskPost(anchor: Point, size: PetSize): Point {
  return { x: anchor.x - size.width / 2, y: anchor.y - size.height };
}

export function wanderPost(from: Point, bounds: PetBounds, obstacles: Rect[], size: PetSize, random = Math.random): Point | undefined {
  for (let attempt = 0; attempt < 20; attempt++) {
    const angle = random() * Math.PI * 2, distance = 60 + random() * 120;
    const to = boundPet({ x: from.x + Math.cos(angle) * distance, y: from.y + Math.sin(angle) * distance }, bounds.x, bounds.y, bounds.top, size);
    if (Math.hypot(to.x - from.x, to.y - from.y) < 24) continue;
    // The entire straight walk must fit in free space, not just its endpoint.
    const swept = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x) + size.width, height: Math.abs(to.y - from.y) + size.height + size.tagHeight };
    if (swept.x >= 0 && swept.y >= bounds.top && swept.x + swept.width <= bounds.x && swept.y + swept.height <= bounds.y && obstacles.every(rect => !overlaps(swept, rect))) return to;
  }
}

// Visibility-graph routing in top-left coordinates. Expand obstacles by the pet
// footprint so every segment, not only each waypoint, has enough walking room.
export function petPath(from: Point, to: Point, bounds: PetBounds, obstacles: Rect[], size: PetSize): Point[] | undefined {
  const start = boundPet(from, bounds.x, bounds.y, bounds.top, size), goal = boundPet(to, bounds.x, bounds.y, bounds.top, size);
  const blocks = obstacles.map(r => ({ x: r.x - size.width - 4, y: r.y - size.height - size.tagHeight - 4, width: r.width + size.width + 8, height: r.height + size.height + size.tagHeight + 8 }));
  const inside = (p: Point, r: Rect) => p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
  const inBounds = (p: Point) => p.x >= 0 && p.y >= bounds.top && p.x + size.width <= bounds.x && p.y + size.height + size.tagHeight <= bounds.y;
  if (!inBounds(start) || !inBounds(goal)) return undefined;
  const free = (p: Point) => inBounds(p) && blocks.every(r => !inside(p, r));
  const crosses = (a: Point, b: Point, r: Rect) => {
    let lo = 0, hi = 1;
    for (const axis of ['x', 'y'] as const) {
      const delta = b[axis] - a[axis], min = r[axis] + .01, max = r[axis] + (axis === 'x' ? r.width : r.height) - .01;
      if (Math.abs(delta) < .001) { if (a[axis] <= min || a[axis] >= max) return false; }
      else { const t1 = (min - a[axis]) / delta, t2 = (max - a[axis]) / delta; lo = Math.max(lo, Math.min(t1, t2)); hi = Math.min(hi, Math.max(t1, t2)); }
    }
    return lo < hi;
  };
  const clear = (a: Point, b: Point, ignore: Rect[] = []) => blocks.every(r => ignore.includes(r) || !crosses(a, b, r));
  const corners = blocks.flatMap(r => [r.x, r.x + r.width].flatMap(x => [r.y, r.y + r.height].map(y => ({ x, y })))).filter(free);
  // A dragged pet may start inside a bubble. The dock also deliberately overlaps
  // its own bubble edge. Only these short departure/arrival legs may cross it.
  const escape = (p: Point): Point | undefined => {
    const containing = blocks.filter(r => inside(p, r));
    if (!containing.length) return p;
    const candidates = [...corners, ...containing.flatMap(r => [
      { x: r.x, y: p.y }, { x: r.x + r.width, y: p.y }, { x: p.x, y: r.y }, { x: p.x, y: r.y + r.height },
    ])].filter(q => free(q) && clear(p, q, containing));
    return candidates.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y))[0];
  };
  const a = escape(start), b = escape(goal);
  if (!a || !b) return undefined;
  const vertices = [a, b, ...corners], distances = vertices.map(() => Infinity), previous = vertices.map(() => -1), visited = new Set<number>();
  distances[0] = 0;
  while (visited.size < vertices.length) {
    let next = -1;
    for (let i = 0; i < vertices.length; i++) if (!visited.has(i) && (next < 0 || distances[i] < distances[next])) next = i;
    if (next < 0 || !Number.isFinite(distances[next])) return undefined;
    if (next === 1) break;
    visited.add(next);
    for (let i = 0; i < vertices.length; i++) {
      if (visited.has(i) || !clear(vertices[next], vertices[i])) continue;
      const distance = distances[next] + Math.hypot(vertices[next].x - vertices[i].x, vertices[next].y - vertices[i].y);
      if (distance < distances[i]) { distances[i] = distance; previous[i] = next; }
    }
  }
  const path: Point[] = [];
  for (let at = 1; at >= 0; at = previous[at]) path.unshift(vertices[at]);
  if (Math.hypot(a.x - start.x, a.y - start.y) < 1) path.shift();
  if (Math.hypot(b.x - goal.x, b.y - goal.y) >= 1) path.push(goal);
  return path;
}
export function bubbleWander(frame: Rect, bounds: PetBounds, size: PetSize, random = Math.random): Point {
  const gap = 8, edge = Math.floor(random() * 4), offset = random();
  const x = frame.x - size.width - gap, right = frame.x + frame.width + gap;
  const y = frame.y - size.height - size.tagHeight - gap, bottom = frame.y + frame.height + gap;
  return boundPet(edge === 0 ? { x: x + (right - x) * offset, y } : edge === 1 ? { x: right, y: y + (bottom - y) * offset }
    : edge === 2 ? { x: x + (right - x) * offset, y: bottom } : { x, y: y + (bottom - y) * offset }, bounds.x, bounds.y, bounds.top, size);
}
