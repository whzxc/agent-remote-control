import test from 'node:test';
import assert from 'node:assert/strict';
import { builtinPets, withBuiltinPets } from '../ui/pets/builtins.ts';
import { selectPet, type PetPackage } from '../ui/pets/model.ts';
import { mascotAnchors, type MascotContact } from '../ui/pets/mascotGeometry.ts';
import type { PetAction } from '../ui/pets/behavior.ts';

const imported: PetPackage = { key: 'arc:example', id: 'example', name: 'Example', version: 2, origin: 'arc', pixelArt: false, source: { site: 'zip' } };

test('built-in companions survive empty refreshes without duplicating imported pets', () => {
  // Property: merging built-in companions is idempotent, preserves external packages, and does not mutate the source catalog.
  for (const incoming of [[], [imported], [...builtinPets, imported], [...builtinPets, ...builtinPets, imported]]) {
    const before = [...incoming], merged = withBuiltinPets(incoming);
    assert.deepEqual(incoming, before);
    assert.deepEqual(withBuiltinPets(merged), merged);
    assert.equal(new Set(merged.map(pet => pet.key)).size, merged.length);
    assert.ok(builtinPets.every(pet => merged.includes(pet)));
    for (const pet of incoming.filter(pet => pet.origin !== 'builtin')) assert.ok(merged.includes(pet));
  }
});

test('brand companions respect every explicit skin assignment', () => {
  // Property: a known brand selects its matching built-in mascot unless an installed participant, platform, or global assignment overrides it.
  const packages = withBuiltinPets([imported]);
  for (const brand of ['claude', 'codex'] as const) {
    const participant = { id: `agent:${brand}`, platform: 'example', brand };
    const recommended = selectPet(participant, packages, {});
    assert.equal(recommended?.mascot, brand === 'claude' ? 'clawd' : 'codex');
    for (const scope of [participant.id, 'platform:example', 'default']) {
      assert.equal(selectPet(participant, packages, { [scope]: imported.key }), imported);
      assert.equal(selectPet(participant, packages, { [scope]: 'missing' }), recommended);
    }
    assert.equal(selectPet(participant, [], {}), undefined);
    assert.equal(selectPet(participant, [imported], {}), imported);
  }
});

test('mascot reaches mirror without moving their support anchors', () => {
  // Property: every action has finite normalized anchors; reversing facing mirrors hand and grip while preserving seat and feet.
  const actions: PetAction[] = ['idle', 'give', 'catch', 'carry', 'work', 'wait', 'think', 'celebrate', 'tired'];
  const contacts: (MascotContact | undefined)[] = [undefined, 'sit', 'swing', 'pull'];
  for (const kind of ['clawd', 'codex'] as const) for (const action of actions) for (const contact of contacts) {
    const right = mascotAnchors(kind, action, contact, 1), left = mascotAnchors(kind, action, contact, -1);
    for (const point of [...Object.values(right), ...Object.values(left)]) {
      assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
      assert.ok(point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1);
    }
    for (const name of ['hand', 'grip'] as const) {
      assert.ok(Math.abs(left[name].x + right[name].x - 1) < 1e-12);
      assert.equal(left[name].y, right[name].y);
    }
    assert.deepEqual(left.seat, right.seat);
    assert.deepEqual(left.feet, right.feet);
  }
});
