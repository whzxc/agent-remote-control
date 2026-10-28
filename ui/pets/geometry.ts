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
