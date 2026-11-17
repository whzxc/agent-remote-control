import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasFrame, petBrand, selectPet, type PetPackage, type Participant } from '../ui/pets/model.ts';
import { boundPet, petSize, participantPost, overlaps, wanderPost } from '../ui/pets/geometry.ts';

test('atlas frames stay inside each supported row', () => {
  // Algorithmic core: every clamped frame remains in its supported v1 or v2 atlas cell.
  for (const version of [1, 2] as const) for (let row = -2; row < 15; row++) for (let frame = -2; frame < 12; frame++) {
    const a = atlasFrame(version, row, frame);
    assert.ok(a.row >= 0 && a.row < (version === 1 ? 9 : 11));
    assert.ok(a.frame >= 0 && a.frame < a.frames);
  }
});
test('wandering never crosses obstacles or leaves the scene', () => {
  // Algorithmic core: every accepted walk has its complete swept footprint inside the bounds and outside obstacles.
  const size = petSize('participant'), from = { x: 300, y: 300 }, bounds = { x: 900, y: 800, top: 40 };
  const obstacles = [{ x: 100, y: 100, width: 90, height: 300 }];
  for (const value of [0, .2, .4, .6, .8]) {
    const to = wanderPost(from, bounds, obstacles, size, () => value);
    if (!to) continue;
    const swept = { x: Math.min(from.x, to.x), y: Math.min(from.y, to.y), width: Math.abs(to.x - from.x) + size.width, height: Math.abs(to.y - from.y) + size.height };
    assert.ok(swept.x >= 0 && swept.y >= bounds.top && swept.x + swept.width <= bounds.x && swept.y + swept.height <= bounds.y);
    assert.ok(obstacles.every(rect => !overlaps(swept, rect)));
  }
  assert.equal(wanderPost(from, bounds, [{ x: 0, y: 0, width: bounds.x, height: bounds.y }], size), undefined);
});
test('binding overrides are participant-specific and do not invent assets', () => {
  // Algorithmic core: participant assignments override platform defaults, which override the global default; absent assets fall back to an installed package.
  const packages = ['a', 'b'].map(key => ({ key, id: key, name: key } as PetPackage));
  const p: Participant = { id: 'source:example', nativeId: 'example', name: 'Example', brand: 'other', kind: 'source', platform: 'example' };
  assert.equal(selectPet(p, [], {}), undefined);
  assert.equal(selectPet(p, packages, {})?.key, 'a');
  assert.equal(selectPet(p, packages, { default: 'b' })?.key, 'b');
  assert.equal(selectPet(p, packages, { default: 'b', 'platform:example': 'a' })?.key, 'a');
  assert.equal(selectPet(p, packages, { default: 'a', 'platform:example': 'a', [p.id]: 'b' })?.key, 'b');
  assert.equal(selectPet(p, packages, { [p.id]: 'missing', default: 'b' })?.key, 'b');
  assert.equal(selectPet(p, packages, { [p.id]: 'missing', 'platform:example': 'a', default: 'b' })?.key, 'a');
  assert.equal(petBrand('claude'), 'claude'); assert.equal(petBrand('chatgpt'), 'codex'); assert.equal(petBrand('example'), 'other');
});
test('drag bounds are idempotent and exclude the title strip', () => {
  // Algorithmic core: bounded positions are stable under reclamping and remain below the drag strip at narrow widths.
  for (const kind of ['participant', 'task'] as const) for (const tagged of [false, true]) for (const width of [40, 320, 1440]) for (const height of [40, 600, 1000]) for (const x of [-100, 0, 5000]) for (const y of [-100, 0, 5000]) {
    const size = petSize(kind, tagged), p = boundPet({ x, y }, width, height, 40, size);
    assert.deepEqual(boundPet(p, width, height, 40, size), p); assert.ok(p.x >= 0); assert.ok(p.y >= 40);
    if (width >= size.width) assert.ok(p.x + size.width <= width);
    if (height >= 40 + size.height + size.tagHeight) assert.ok(p.y + size.height + size.tagHeight <= height + 1e-9);
  }
});

test('participant posts prefer the hub side and keep their full footprint clear', () => {
  // Algorithmic core: every selected post contains the pet and tag in bounds and excludes supplied node and label rectangles.
  const bounds = { x: 1000, y: 900, top: 40 };
  for (const right of [false, true]) for (const portrait of [false, true]) for (const tagged of [false, true]) {
    const size = petSize('participant', tagged), node = { x: right ? 230 : 730, y: 400, width: 44, height: 44 };
    const label = portrait
      ? { x: right ? node.x - 140 : node.x + node.width, y: node.y, width: 140, height: 44 }
      : { x: node.x - 48, y: node.y + node.height, width: 140, height: 28 };
    const hub = { x: 500, y: portrait ? 200 : 400 };
    const post = participantPost(node, hub, [label], bounds, size)!;
    assert.ok(post);
    const footprint = { ...post, width: size.width, height: size.height + size.tagHeight };
    assert.ok(!overlaps(footprint, node) && !overlaps(footprint, label));
    assert.ok(right ? post.x >= node.x + node.width : post.x + size.width <= node.x);
    assert.ok(post.x >= 0 && post.x + size.width <= bounds.x && post.y >= bounds.top && post.y + footprint.height <= bounds.y);
    const displaced = participantPost(node, hub, [label, footprint], bounds, size);
    if (displaced) assert.ok(!overlaps({ ...displaced, width: size.width, height: footprint.height }, footprint));
  }
  assert.equal(participantPost({ x: 0, y: 0, width: bounds.x, height: bounds.y }, { x: 500, y: 400 }, [], bounds, petSize('participant')), undefined);
});
