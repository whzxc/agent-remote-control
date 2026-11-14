/** Perspective spacing is continuous between card slots, including while a pointer is held. */
export function deckGeometry(depth: number, stride: number, flatStride = stride, spread = 0) {
  const flat = Math.min(depth, spread);
  const d = Math.max(0, depth - spread), whole = Math.floor(d), fraction = d - whole;
  const ratio = .78;
  const offset = flat * flatStride + stride * ((1 - ratio ** whole) / (1 - ratio) + fraction * ratio ** whole);
  return { offset, scale: 1 - Math.min(d, 10) * .035, fog: Math.min(d * .09, .5),
    opacity: d > 7 ? Math.max(0, 8 - d) : 1,
    strip: d === 0 ? Infinity : stride * ratio ** Math.max(0, d - 1) };
}
export function deckRelease(position: number, velocity: number, stride: number, count: number) {
  return Math.min(Math.max(0, count - 1), Math.max(0, Math.round((position + velocity * 180) / stride))) * stride;
}
