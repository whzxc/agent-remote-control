import test from 'node:test';
import assert from 'node:assert/strict';
import { atlasFrame, boundPet, petBrand, selectPet, type PetPackage, type Participant } from '../ui/pets/model.ts';
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
  for (const width of [40, 320, 1440]) for (const height of [40, 600, 1000]) for (const x of [-100, 0, 5000]) for (const y of [-100, 0, 5000]) {
    const p = boundPet({ x, y }, width, height, 40);
    assert.deepEqual(boundPet(p, width, height, 40), p); assert.ok(p.x >= 0); assert.ok(p.y >= 40);
  }
});
