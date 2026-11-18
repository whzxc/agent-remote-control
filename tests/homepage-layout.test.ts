import test from 'node:test';
import assert from 'node:assert/strict';
import { solve, type Entity } from '../ui/topology/solve.ts';

test('task observations do not enter the node solver', () => {
  // Algorithmic core: dispatch observation exclusion from node solver
  const roots: Entity[] = [{ id: 'agent', children: [{ id: 'account-one' }, { id: 'account-two' }] }];
  const scene = { vw: 1280, vh: 800, left: [], right: roots };
  const before = solve(scene);
  const observed = roots.map(node => ({ ...node, tasks: [{ id: 'unprojected-task', width: 400, height: 600 }], activityLevel: 3 }));
  assert.deepEqual(solve({ ...scene, right: observed }), before);
});

;
