import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { planUiRunRetention, pruneUiRuns, screenshotsEnabled } from '../tooling/acceptance/ui-retention.mjs';

test('accept:ui omits screenshots by default and enables them only on --screenshots', () => {
  // Contract: UI acceptance defaults to layout-only runs while allowing explicit --screenshots opt-in.
  assert.equal(screenshotsEnabled(['node', 'ui.mjs']), false);
  assert.equal(screenshotsEnabled(['node', 'ui.mjs', '--scenario=idle']), false);
  assert.equal(screenshotsEnabled(['node', 'ui.mjs', '--screenshots']), true);
  assert.equal(screenshotsEnabled(['node', 'ui.mjs', '--screenshots', '--no-screenshots']), false);
});

test('accept:ui retention keeps the latest two run directories per engine without evicting the screenshot baseline', async t => {
  // Property: each engine retains at most two screenshot runs and two layout runs after creating the new run directory, leaving other engines and non-run entries untouched.
  const entries = [
    '2026-11-15T01-00-00.000Z-chromium',
    '2026-11-15T02-00-00.000Z-chromium',
    '2026-11-15T03-00-00.000Z-chromium',
    '2026-11-15T01-30-00.000Z-chromium-layout',
    '2026-11-15T02-30-00.000Z-chromium-layout',
    '2026-11-15T01-00-00.000Z-webkit',
    '2026-11-15T02-00-00.000Z-webkit',
    '2026-11-15T03-00-00.000Z-webkit',
    'notes',
  ];

  const layoutPlan = planUiRunRetention(entries, 'chromium', false);
  assert.equal(layoutPlan.previous, '2026-11-15T03-00-00.000Z-chromium');
  assert.deepEqual(layoutPlan.remove, [
    '2026-11-15T01-00-00.000Z-chromium',
    '2026-11-15T01-30-00.000Z-chromium-layout',
  ]);

  const screenshotPlan = planUiRunRetention(entries, 'chromium', true);
  assert.equal(screenshotPlan.previous, '2026-11-15T03-00-00.000Z-chromium');
  assert.deepEqual(screenshotPlan.remove, [
    '2026-11-15T01-00-00.000Z-chromium',
    '2026-11-15T02-00-00.000Z-chromium',
  ]);

  const base = await mkdtemp(path.join(tmpdir(), 'arc-ui-retention-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  for (const dir of entries) await mkdir(path.join(base, dir));
  await writeFile(path.join(base, '2026-11-15T00-00-00.000Z-chromium'), 'not-a-directory');

  const previous = await pruneUiRuns(base, 'chromium', true);
  assert.equal(previous, '2026-11-15T03-00-00.000Z-chromium');
  assert.deepEqual((await readdir(base)).sort(), [
    '2026-11-15T00-00-00.000Z-chromium',
    '2026-11-15T01-00-00.000Z-webkit',
    '2026-11-15T01-30-00.000Z-chromium-layout',
    '2026-11-15T02-00-00.000Z-webkit',
    '2026-11-15T02-30-00.000Z-chromium-layout',
    '2026-11-15T03-00-00.000Z-chromium',
    '2026-11-15T03-00-00.000Z-webkit',
    'notes',
  ]);
});
