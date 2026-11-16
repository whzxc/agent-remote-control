import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { selectScenarios, smokeScenarios, reusableCases, uiFingerprint } from '../tooling/acceptance/ui-plan.mjs';

test('default acceptance selects smoke cases while explicit scopes remain available', () => {
  // Regression: a routine release repeatedly ran every UI scenario and width.
  const files = [...smokeScenarios, 'other', 'other-detail'].map(name => `${name}.json`);
  assert.deepEqual(selectScenarios(files), smokeScenarios.map(name => `${name}.json`).sort());
  assert.deepEqual(selectScenarios(files, { filter: 'idle,other*' }), ['idle.json', 'other-detail.json', 'other.json']);
  assert.deepEqual(selectScenarios(files, { all: true }), files.sort());
  assert.throws(() => selectScenarios(files, { filter: 'missing' }), /No acceptance scenario/);
  assert.throws(() => selectScenarios(files, { all: true, filter: 'idle' }), /Choose/);
});

test('only matching successful layout cases are reusable', () => {
  // Property: changed inputs and explicit fresh runs cannot reuse earlier passes.
  const cache = { fingerprint: 'same', passed: ['idle@light-1280x800:behavior'] };
  assert.deepEqual([...reusableCases(cache, 'same')], cache.passed);
  assert.equal(reusableCases(cache, 'changed').size, 0);
  assert.equal(reusableCases(cache, 'same', true).size, 0);
  assert.equal(reusableCases(undefined, 'same').size, 0);
});

test('UI passes survive documentation edits and staging but invalidate on UI inputs', async t => {
  // Regression: repeated release checks must reuse passes without accepting changed UI or browser inputs.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-ui-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  await mkdir(path.join(root, 'ui'));
  await writeFile(path.join(root, 'ui', 'App.tsx'), 'first');
  const runtime = { browser: '1', node: '24', platform: 'darwin', arch: 'arm64' };
  const before = await uiFingerprint(root, runtime);
  await writeFile(path.join(root, 'README.md'), 'documentation');
  execFileSync('git', ['-C', root, 'add', '.']);
  assert.equal(await uiFingerprint(root, runtime), before);
  assert.notEqual(await uiFingerprint(root, { ...runtime, browser: '2' }), before);
  await writeFile(path.join(root, 'ui', 'App.tsx'), 'changed');
  assert.notEqual(await uiFingerprint(root, runtime), before);
  await writeFile(path.join(root, 'ui', 'App.tsx'), 'first');
  await writeFile(path.join(root, 'ui', 'New.tsx'), 'new');
  assert.notEqual(await uiFingerprint(root, runtime), before);
  await rm(path.join(root, 'ui', 'New.tsx'));
  await rm(path.join(root, 'ui', 'App.tsx'));
  assert.notEqual(await uiFingerprint(root, runtime), before);
});
