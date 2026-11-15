import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { checkStyles, tokenPaint } from '../tooling/check-ui-styles.mjs';
import { checkConsumers } from '../tooling/check-ui-consumers.mjs';
import { checkTokens } from '../tooling/check-ui-tokens.mjs';
import { lengthDifference, deltaE, valueDifference } from '../tooling/token-distance.mjs';

test('feature presentation accepts tokens and rejects unowned literal paint', async () => {
  // Regression: layout-only policy forced single-feature visuals into the shared library.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-style-policy-'));
  try {
    await mkdir(path.join(root, 'ui/components/ui'), { recursive: true });
    await mkdir(path.join(root, 'tooling'));
    await writeFile(path.join(root, 'ui/feature.css'), '.row { display:flex; gap:8px; color:var(--text); border:var(--stroke) solid var(--border); background:color-mix(in srgb,var(--accent) 12%,transparent); border-radius:var(--radius); font:var(--weight-strong) var(--text-small)/var(--line) var(--font-ui); box-shadow:none; }');
    const allowlist = path.join(root, 'tooling/ui-style-allowlist.json');
    await writeFile(allowlist, '[]');
    assert.deepEqual((await checkStyles(root)).errors, []);
    await writeFile(path.join(root, 'ui/feature.css'), '.row { color:red; border-radius:12px; font-size:13px; box-shadow:0 2px 4px #000; }');
    assert.equal((await checkStyles(root)).errors.length, 4);
    await writeFile(allowlist, JSON.stringify(['color','border-radius','font-size','box-shadow'].map(property => ({file:'ui/feature.css',selector:'.row',property,reason:'Device illustration artwork uses this painted canvas shape.'}))));
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


test('runtime paint tokens require semantic names and independent feature consumers', async () => {
  // Regression: governance wrapped single-feature literals in globally named tokens.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-token-policy-'));
  try {
    for (const dir of ['design', 'tooling', 'ui/components/ui', 'ui/devices', 'ui/pets']) await mkdir(path.join(root, dir), { recursive: true });
    await writeFile(path.join(root, 'design/tokens.css'), ':root { --text: #222; --radius-7: 7px; --art-glow: gold; --ink: var(--text); }');
    await writeFile(path.join(root, 'ui/components/ui/part.tsx'), 'export function Part(){return <span className="part"/>}');
    await writeFile(path.join(root, 'ui/components/ui/part.css'), '.part { color:var(--ink); border-radius:var(--radius-7); }');
    await writeFile(path.join(root, 'ui/devices/view.tsx'), 'import {Part} from "../components/ui/part"; export function Device(){return <Part/>}');
    await writeFile(path.join(root, 'ui/devices/view.css'), '.device { background:var(--art-glow); }');
    await writeFile(path.join(root, 'ui/App.tsx'), 'import {Device} from "./devices/view"; export function App(){return <Device/>}');
    let result = checkTokens(root);
    assert.equal(result.tokens.find(row => row.token === '--text').count, 1);
    assert.ok(result.errors.some(error => error.includes('name encodes its literal value')));
    await writeFile(path.join(root, 'ui/pets/view.tsx'), 'import {Part} from "../components/ui/part"; export function Pets(){return <Part/>}');
    await writeFile(path.join(root, 'design/tokens.css'), ':root { --text: #222; --radius-detail: 7px; --art-glow: gold; --ink: var(--text); }');
    await writeFile(path.join(root, 'ui/components/ui/part.css'), '.part { color:var(--ink); border-radius:var(--radius-detail); }');
    await writeFile(path.join(root, 'tooling/ui-token-allowlist.json'), JSON.stringify([{ file: 'design/tokens.css', token: '--art-glow', reason: 'Device artwork preserves the gold glow in its isolated canvas.' }]));
    result = checkTokens(root);
    assert.equal(result.tokens.find(row => row.token === '--text').count, 2);
    assert.deepEqual(result.errors, []);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('small token differences consolidate unless three declarations use the value', async () => {
  // Regression: governance added a two-use 19px line token beside the 18px and 20px scale.
  const root = await mkdtemp(path.join(tmpdir(), 'arc-token-distance-'));
  try {
    for (const dir of ['design', 'tooling', 'ui/components/ui']) await mkdir(path.join(root, dir), {recursive:true});
    await writeFile(path.join(root,'design/tokens.css'), ':root { --line-small:18px; --line-summary:19px; }');
    await writeFile(path.join(root,'ui/feature.css'), '.a{line-height:var(--line-summary)} .b{line-height:var(--line-summary)}');
    assert.ok(checkTokens(root).errors.some(error => error.includes('nearest --line-small')));
    await writeFile(path.join(root,'ui/extra.tsx'), 'export const line = {lineHeight: "var(--line-summary)"};');
    assert.deepEqual(checkTokens(root).errors, []);
    await writeFile(path.join(root,'tooling/ui-style-allowlist.json'), JSON.stringify([{file:'ui/feature.css',selector:'.a',property:'color',reason:'Feature-only decoration.'}]));
    await writeFile(path.join(root,'ui/feature.css'), '.a{color:red}');
    assert.ok((await checkStyles(root)).errors.some(error => error.includes('artwork exception')));
    assert.ok(checkTokens(root).errors.some(error => error.includes('literal color')));
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('normalization thresholds require both absolute and relative length differences', () => {
  // Property: large lengths exceed both thresholds; equal colors have zero perceptual distance.
  assert.equal(lengthDifference(22,24).large,false);
  assert.equal(lengthDifference(27,24).large,false);
  assert.equal(lengthDifference(42,28).large,true);
  assert.equal(deltaE('#ffffff','#ffffff'),0);
  assert.equal(valueDifference('color',['#7d63c9','#b9a6ff'],['#6a5ad0','#ab9fff']).large,false);
  assert.equal(valueDifference('shadow',['inset 0 -1px #000'],['0 1px 2px #000']).large,true);
  assert.equal(valueDifference('font-weight',['650'],['600']).large,false);
  assert.equal(valueDifference('font-weight',['800'],['600']).large,true);
});
