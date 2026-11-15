import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkStyles } from '../tooling/check-ui-styles.mjs';

test('feature paint needs an exact owner exception while layout remains free', async () => {
  // Regression: feature styles painted shared chips without an implementation owner.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-style-policy-'));
  try {
    await mkdir(path.join(root, 'ui/components/ui'), { recursive: true });
    await mkdir(path.join(root, 'tooling'));
    await writeFile(path.join(root, 'ui/feature.css'), '.row { display: flex; gap: 8px; color: red; font-weight: 600; }');
    await writeFile(path.join(root, 'ui/components/ui/control.css'), '.control { color: blue; }');
    const allowlist = path.join(root, 'tooling/ui-style-allowlist.json');
    await writeFile(allowlist, '[]');
    assert.equal((await checkStyles(root)).errors.length, 2);
    await writeFile(allowlist, JSON.stringify(['color', 'font-weight'].map(property => ({
      file: 'ui/feature.css', selector: '.row', property, reason: 'Synthetic feature content specimen.',
    }))));
    assert.deepEqual((await checkStyles(root)).errors, []);
    await writeFile(path.join(root, 'ui/feature.css'), '.other { color: red; font-weight: 600; }');
    assert.equal((await checkStyles(root)).errors.length, 4);
  } finally { await rm(root, { recursive: true, force: true }); }
});
