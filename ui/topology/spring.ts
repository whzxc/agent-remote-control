export type SpringValue = { x: number; v: number; t: number };
export function integrateSpring(value: SpringValue, dt: number, stiffness: number, damping: number) {
  const substeps = Math.max(1, Math.ceil(dt / .008)), step = dt / substeps;
  for (let index = 0; index < substeps; index++) {
    value.v += (-stiffness * (value.x - value.t) - damping * value.v) * step;
    value.x += value.v * step;
  }
  const moving = Math.abs(value.x - value.t) > .01 || Math.abs(value.v) > .01;
  if (!moving) { value.x = value.t; value.v = 0; }
  return moving;
}
