import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasFrame, petBrand, selectPet, type PetPackage, type Participant } from '../ui/pets/model.ts';
import { boundPet, petSize, participantPost, overlaps, bubbleEnd, taskPost } from '../ui/pets/geometry.ts';

test('atlas frames stay inside each supported row', () => {
  // Property: every clamped frame remains in its supported v1 or v2 atlas cell.
  for (const version of [1, 2] as const) for (let row = -2; row < 15; row++) for (let frame = -2; frame < 12; frame++) {
    const a = atlasFrame(version, row, frame);
    assert.ok(a.row >= 0 && a.row < (version === 1 ? 9 : 11));
    assert.ok(a.frame >= 0 && a.frame < a.frames);
  }
});
test('binding overrides are participant-specific and do not invent assets', () => {
  // Property: participant assignments take precedence over brand defaults and never resolve missing packages.
  const packages = ['a', 'b'].map(key => ({ key, id: key } as PetPackage));
  const p: Participant = { id: 'agent:example', nativeId: 'example', name: 'Example', brand: 'other', kind: 'agent' };
  assert.equal(selectPet(p, packages, {}), undefined);
  assert.equal(selectPet(p, packages, { 'brand:other': 'a' })?.key, 'a');
  assert.equal(selectPet(p, packages, { 'brand:other': 'a', [p.id]: 'b' })?.key, 'b');
  assert.equal(selectPet(p, packages, { [p.id]: 'missing' }), undefined);
  assert.equal(petBrand('claude'), 'claude'); assert.equal(petBrand('chatgpt'), 'codex'); assert.equal(petBrand('example'), 'other');
});
test('drag bounds are idempotent and exclude the title strip', () => {
  // Property: bounded positions are stable under reclamping and remain below the drag strip at narrow widths.
  for (const kind of ['participant', 'task'] as const) for (const tagged of [false, true]) for (const width of [40, 320, 1440]) for (const height of [40, 600, 1000]) for (const x of [-100, 0, 5000]) for (const y of [-100, 0, 5000]) {
    const size = petSize(kind, tagged), p = boundPet({ x, y }, width, height, 40, size);
    assert.deepEqual(boundPet(p, width, height, 40, size), p); assert.ok(p.x >= 0); assert.ok(p.y >= 40);
    if (width >= size.width) assert.ok(p.x + size.width <= width);
    if (height >= 40 + size.height + size.tagHeight) assert.ok(p.y + size.height + size.tagHeight <= height + 1e-9);
  }
});

test('pet dimensions preserve cell aspect and task scale independently of tags', () => {
  // Property: task sprites scale uniformly from participant sprites and tags never alter the atlas cell aspect.
  for (const tagged of [false, true]) {
    const participant = petSize('participant', tagged), task = petSize('task', tagged);
    for (const size of [participant, task, petSize('preview', tagged)]) assert.ok(Math.abs(size.width / size.height - 192 / 208) < 1e-12);
    assert.ok(Math.abs(task.width / participant.width - .6) < 1e-12);
    assert.ok(Math.abs(task.height / participant.height - .6) < 1e-12);
    assert.equal(participant.width, petSize('participant').width);
    assert.equal(participant.height, petSize('participant').height);
    assert.equal(task.tagHeight, participant.tagHeight);
  }
});
test('participant posts prefer the hub side and keep their full footprint clear', () => {
  // Property: every selected post contains the pet and tag in bounds and excludes supplied node and label rectangles.
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
test('task pets stand at the bubble end across left and right anchored geometries', () => {
  // Property: changing a bubble's anchor encoding preserves its pet destination at the right edge with feet on the bottom edge.
  const size = petSize('task');
  for (const width of [120, 264, 480]) for (const height of [48, 76, 120]) for (const left of [20, 600, 976]) {
    const centerY = 400;
    const landscape = bubbleEnd({ x: left, y: centerY, width, height, anchor: 0 });
    const portrait = bubbleEnd({ x: left + width, y: centerY, width, height, anchor: 1 });
    assert.deepEqual(landscape, portrait);
    const post = taskPost(landscape, size);
    assert.ok(Math.abs(post.x + size.width / 2 - (left + width)) < 1e-9);
    assert.ok(Math.abs(post.y + size.height - (centerY + height / 2)) < 1e-9);
  }
});
