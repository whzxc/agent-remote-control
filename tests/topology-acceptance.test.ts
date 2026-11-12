import test from 'node:test';
import assert from 'node:assert/strict';
import { representedTopologyRoots } from '../tooling/acceptance/topology.mjs';

const position = { presence: 1 };
test('coverage retains root identity across unfolding and side collapse', () => {
  // Property: folded root membership and unfolded real roots cover the same identities without counting child groups, dormant groups or the opposite wing.
  const members = ['a', 'b', 'c'];
  for (const side of [-1, 1]) {
    const group = { side, members, folded: true, position };
    const folded = { groups: [group], nodes: [{ id: 'capsule', side, group: {}, position }] };
    const open = { groups: [{ ...group, folded: false }], nodes: members.map(id => ({ id, side, position })) };
    assert.deepEqual(representedTopologyRoots(folded, side), representedTopologyRoots(open, side));
    assert.deepEqual(representedTopologyRoots(open, -side), []);
    assert.deepEqual(representedTopologyRoots({ groups: [{ ...group, folded: false }], nodes: [] }, side), []);
  }
});
