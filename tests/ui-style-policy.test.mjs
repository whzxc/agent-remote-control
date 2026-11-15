import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkStyles, tokenPaint } from '../tooling/check-ui-styles.mjs';
import { checkConsumers } from '../tooling/check-ui-consumers.mjs';

test('feature presentation accepts tokens and rejects unowned literal paint', async () => {
  // Regression: layout-only policy forced single-feature visuals into the shared library.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-style-policy-'));
  try {
    await mkdir(path.join(root, 'ui/components/ui'), { recursive: true });
    await mkdir(path.join(root, 'tooling'));
    await writeFile(path.join(root, 'ui/feature.css'), '.row { display:flex; gap:8px; color:var(--text); border:var(--stroke) solid var(--border); background:color-mix(in srgb,var(--accent) 12%,transparent); border-radius:var(--radius); font:600 var(--text-small)/var(--line) var(--font-ui); box-shadow:none; }');
    const allowlist = path.join(root, 'tooling/ui-style-allowlist.json');
    await writeFile(allowlist, '[]');
    assert.deepEqual((await checkStyles(root)).errors, []);
    await writeFile(path.join(root, 'ui/feature.css'), '.row { color:red; border-radius:12px; font-size:13px; box-shadow:0 2px 4px #000; }');
    assert.equal((await checkStyles(root)).errors.length, 4);
    await writeFile(allowlist, JSON.stringify(['color','border-radius','font-size','box-shadow'].map(property => ({file:'ui/feature.css',selector:'.row',property,reason:'Illustrated canvas shape.'}))));
    assert.deepEqual((await checkStyles(root)).errors, []);
    assert.equal(tokenPaint('var(--ink, red)', 'color'), false);
    assert.equal(tokenPaint('var(--ink, currentColor)', 'color'), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('shared parts count feature boundaries through aliases without counting composition ancestors', async () => {
  // Regression: feature-local wrappers appeared reusable when App ancestors were counted as consumers.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-consumer-policy-'));
  try {
    for (const dir of ['ui/components/ui','ui/devices','ui/pets']) await mkdir(path.join(root,dir),{recursive:true});
    await writeFile(path.join(root,'ui/components/ui/part.tsx'),'export function Part(){return <span/>}');
    await writeFile(path.join(root,'ui/components/ui/index.ts'),'export {Part as Mark} from "./part";');
    await writeFile(path.join(root,'ui/devices/one.tsx'),'import {Mark} from "../components/ui"; export function One(){return <Mark/>}');
    await writeFile(path.join(root,'ui/devices/two.tsx'),'import {Mark} from "../components/ui"; export function Two(){return <Mark/>}');
    await writeFile(path.join(root,'ui/App.tsx'),'import {One} from "./devices/one"; export function App(){return <One/>}');
    assert.equal(checkConsumers(root).parts[0].count, 1);
    await writeFile(path.join(root,'ui/pets/view.tsx'),'import {Mark} from "../components/ui"; export function Pet(){return <Mark/>}');
    assert.deepEqual(checkConsumers(root).errors, []);
  } finally { await rm(root,{recursive:true,force:true}); }
});
