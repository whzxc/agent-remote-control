import test from 'node:test';
import assert from 'node:assert/strict';
import { representedTopologyRoots } from '../tooling/acceptance/topology.mjs';

const position = { presence: 1 };
test('acceptance represents folded Agents and sources through group membership', () => {
  // Regression: topology-accounts-dense rejected folded Agents and portrait-topology-4 timed out waiting for four independent source nodes.
  const topology = {
    nodes: [
      { id: 'codex', side: 1, position }, { id: 'accounts', side: 1, parent: 'codex', group: {}, position },
      { id: 'agents', side: 1, group: {}, position },
      { id: 'openai', side: -1, position }, { id: 'sources', side: -1, group: {}, position },
    ],
    groups: [
      { side: 1, members: ['claude', 'opencode', 'dsh', 'cursor'], folded: true, position },
      { side: 1, parent: 'codex', members: ['account-03', 'account-04'], folded: true, position },
      { side: -1, members: ['anthropic', 'google', 'xai'], folded: true, position },
    ],
  };
  assert.deepEqual(representedTopologyRoots(topology, 1), ['codex', 'claude', 'opencode', 'dsh', 'cursor']);
  assert.deepEqual(representedTopologyRoots(topology, -1), ['openai', 'anthropic', 'google', 'xai']);
});

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
