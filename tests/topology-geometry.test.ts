import test from "node:test";
import assert from "node:assert/strict";
import { hubMarkGeometry, grownWire, arcPath } from "../ui/topology/geometry.ts";

test("hub arc ends maintain clearance from each growing dot", () => {
  // Property: growing either DOT independently shortens both adjacent arcs while retaining equal cap clearance.
  const base = hubMarkGeometry();
  const clearance = (angle: number, scale: number) => 2 * 32 * Math.sin(angle / 2) - 10 * scale;
  for (const scale of [1.1, 1.25]) {
    const source = hubMarkGeometry(scale, 1), agent = hubMarkGeometry(1, scale);
    assert.ok(source.sourceAngle > base.sourceAngle);
    assert.equal(source.agentAngle, base.agentAngle);
    assert.ok(agent.agentAngle > base.agentAngle);
    assert.equal(agent.sourceAngle, base.sourceAngle);
    assert.ok(Math.abs(clearance(source.sourceAngle, scale) - clearance(base.sourceAngle, 1)) < 1e-9);
    assert.equal(source.sourceAngle, agent.agentAngle);
    assert.notEqual(source.top, base.top);
    assert.notEqual(source.bottom, base.bottom);
  }
});
test("path generation skips non-finite coordinates and recovers on the next frame", () => {
  // Property: path generation skips non-finite coordinates and recovers on the next frame.
  const points = [{ x: 484, y: 348 }, { x: 447.5, y: 348 }, { x: 581.82, y: 348 }, { x: 557, y: 348 }];
  const empty = { outline: "", centerline: "", gap: "" };
  for (const invalid of [NaN, Infinity, -Infinity]) {
    for (let i = 0; i < 4; i++) for (const axis of ["x", "y"]) {
      const frame = points.map((p, j) => j === i ? { ...p, [axis]: invalid } : p);
      assert.deepEqual(grownWire(frame[0], frame[1], frame[2], frame[3], 1, 1, true), empty);
    }
    for (let i = 0; i < 5; i++) {
      const args = [450, 340, 130, -30, 30]; args[i] = invalid;
      assert.equal(arcPath(args[0], args[1], args[2], args[3], args[4], 1), "");
    }
    assert.deepEqual(grownWire(points[0], points[1], points[2], points[3], invalid, 1), empty);
  }
  const shape = grownWire(points[0], points[1], points[2], points[3], 1, 1, true);
  assert.ok(shape.centerline && !/NaN|Infinity/.test(shape.centerline));
  assert.ok(shape.outline && !/NaN|Infinity/.test(shape.outline));
});
