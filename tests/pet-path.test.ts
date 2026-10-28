import test from 'node:test';
import assert from 'node:assert/strict';
import { petPath, overlaps, type Rect } from '../ui/pets/geometry.ts';

const bounds = { x: 800, y: 600, top: 30 }, size = { width: 40, height: 50, tagHeight: 0 };
test('a displaced task pet routes around a blocking bubble', () => {
  // Regression: a dragged task pet remained away from its bubble indefinitely.
  const from = { x: 60, y: 200 }, to = { x: 650, y: 200 };
  const obstacle: Rect = { x: 300, y: 140, width: 180, height: 210 };
  const path = petPath(from, to, bounds, [obstacle], size);
  assert.ok(path?.length);
  assert.deepEqual(path.at(-1), to);
  let start = from;
  for (const end of path) {
    for (let i = 0; i <= 100; i++) {
      const point = { x: start.x + (end.x - start.x) * i / 100, y: start.y + (end.y - start.y) * i / 100, ...size };
      assert.ok(!overlaps(point, obstacle));
      assert.ok(point.x >= 0 && point.y >= bounds.top && point.x + size.width <= bounds.x && point.y + size.height <= bounds.y);
    }
    start = end;
  }
});
test('an impassable barrier does not cause a teleport', () => {
  // Property: routing cannot cross an obstacle spanning the complete scene height.
  assert.equal(petPath({ x: 60, y: 200 }, { x: 650, y: 200 }, bounds,
    [{ x: 300, y: 0, width: 180, height: bounds.y }], size), undefined);
});
test('pets can leave an overlapping drop and dock at their own bubble edge', () => {
  // Property: occupied start and goal positions permit only bounded departure and arrival legs.
  const from = { x: 310, y: 210 }, to = { x: 660, y: 250 };
  const path = petPath(from, to, bounds, [{ x: 300, y: 200, width: 80, height: 100 }, { x: 600, y: 200, width: 80, height: 100 }], size);
  assert.ok(path?.length);
  assert.deepEqual(path.at(-1), to);
  assert.ok(path.every(p => p.x >= 0 && p.y >= bounds.top && p.x + size.width <= bounds.x && p.y + size.height <= bounds.y));
});
