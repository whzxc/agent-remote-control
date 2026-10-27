export type Values = Record<string, number>;
type Spring = { value: number; velocity: number; target: number };
export class TopologyAnimator {
  readonly live = new Map<string, { fields: Record<string, Spring>; alive: boolean }>();
  target(key: string, values: Values, spawn: Values = {}) {
    let primitive = this.live.get(key);
    if (!primitive) { primitive = { fields: {}, alive: true }; this.live.set(key, primitive); }
    primitive.alive = true;
    for (const [name, target] of Object.entries(values)) {
      const field = primitive.fields[name] ??= { value: spawn[name] ?? target, velocity: 0, target };
      field.target = target;
    }
  }
  values(key: string): Values | undefined {
    const primitive = this.live.get(key);
    return primitive && Object.fromEntries(Object.entries(primitive.fields).map(([key, field]) => [key, field.value]));
  }
  retire(key: string, destination: Values) {
    this.target(key, { ...destination, opacity: 0, scale: .5, draw: 0 });
    this.live.get(key)!.alive = false;
  }
  step(dt: number, reduced: boolean) {
    let moving = false;
    for (const [key, primitive] of this.live) {
      for (const field of Object.values(primitive.fields)) {
        if (reduced) { field.value = field.target; field.velocity = 0; continue; }
        const count = Math.max(1, Math.ceil(dt / .008)), h = dt / count;
        for (let i = 0; i < count; i++) {
          field.velocity += (-210 * (field.value - field.target) - 26 * field.velocity) * h;
          field.value += field.velocity * h;
        }
        if (Math.abs(field.value - field.target) > .01 || Math.abs(field.velocity) > .01) moving = true;
        else { field.value = field.target; field.velocity = 0; }
      }
      if (!primitive.alive && primitive.fields.opacity.value < .01) this.live.delete(key);
    }
    return moving;
  }
}
