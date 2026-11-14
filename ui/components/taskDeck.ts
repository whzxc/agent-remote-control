/** Perspective spacing is continuous between card slots, including while a pointer is held. */
export function deckGeometry(depth: number, stride: number) {
  const d = Math.max(0, depth), whole = Math.floor(d), fraction = d - whole;
  const ratio = .78;
  const offset = depth < 0 ? depth * stride : stride * ((1 - ratio ** whole) / (1 - ratio) + fraction * ratio ** whole);
  return { offset, scale: 1 - Math.min(d, 10) * .035, fog: Math.min(d * .09, .5),
    opacity: depth < 0 ? Math.max(0, 1 + depth) : d > 7 ? Math.max(0, 8 - d) : 1,
    strip: depth <= 0 ? Infinity : stride * ratio ** Math.max(0, depth - 1) };
}
export function deckRelease(position: number, velocity: number, stride: number, count: number) {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.round((position + velocity * 180) / stride))) * stride;
}
