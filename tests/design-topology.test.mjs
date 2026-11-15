import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateTopology } from '../tooling/design-topology.mjs';

test('topology design stays synchronized with the production solvers and browser fixtures', async () => {
  // Regression: restored homepage topology was a hand-maintained solver snapshot that silently drifted.
  const inputs = JSON.parse(await readFile(new URL('../design/fixtures/topology-input.json', import.meta.url), 'utf8'));
  for (const input of inputs) {
    const fixture = JSON.parse(await readFile(new URL(`../tooling/acceptance/scenarios/${input.fixture.name}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(input.fixture.data, fixture, 'Browser fixture changed. Run npm run design:topology.');
  }
  const committed = await readFile(new URL('../design/fixtures/topology.ts', import.meta.url), 'utf8');
  assert.equal(await generateTopology(inputs), committed, 'Topology changed. Run npm run design:topology.');
});
