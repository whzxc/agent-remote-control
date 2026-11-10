import {toolResult} from '../tooling/mcp-result.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { canonicalSnapshot, indexPublications, writeRetainedState } from './helpers/index-state.ts';

const target = process.env.CARGO_TARGET_DIR || path.resolve('target');
const binary = path.join(target, 'debug', process.platform === 'win32' ? 'contract-fixture.exe' : 'contract-fixture');
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function eventually<T>(read: () => Promise<T | undefined>, limit = 12000): Promise<T> {
  const until = performance.now() + limit;
  do { const value = await read(); if (value !== undefined) return value; await pause(10); } while (performance.now() < until);
  throw new Error('Core startup did not finish within the fixture budget');
}
async function json(file: string): Promise<any> { try { return JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; } }
async function start(directory: string) {
  const state = path.join(directory, 'state'), home = path.join(directory, 'home');
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, USERPROFILE: home, ARC_STATE_DIR: state, CODEX_HOME: path.join(home, '.codex'), CLAUDE_CONFIG_DIR: path.join(home, '.claude'), ARC_FIXTURE_INDEX_GATE: path.join(directory, 'index-gate') };
  for (const key of ['ARC_DEV_INSTANCE_ID', 'ARC_DEV_OWNER_ID', 'ARC_DEV_TAKEOVER']) delete env[key];
  const wallAt = Date.now(), at = performance.now();
  const child = spawn(binary, ['runtime'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  const exited = once(child, 'exit');
  let errors = ''; child.stderr.on('data', bytes => { errors += bytes; });
  let shutdown: (() => Promise<unknown>) | undefined;
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      if (shutdown) await shutdown().catch(() => child.kill('SIGTERM'));
      else child.kill('SIGTERM');
    }
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try { await exited; } finally { clearTimeout(force); }
    assert.equal(child.signalCode, null, `Core did not shut down cleanly: ${errors}`);
    assert.equal(child.exitCode, 0, errors);
  };
  try {
    const endpoint = await eventually(async () => {
      assert.equal(child.exitCode, null, errors);
      const metadata = await json(path.join(state, 'app/native.json'));
      return metadata?.pid === child.pid ? metadata : undefined;
    }, 5000);
    const request = async (route: string, body?: any, allowError = false) => {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/${route}`, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json(); if (!allowError) assert.ok(response.ok, JSON.stringify(value)); return value as any;
    };
    const call = async (op: string, args = {}) => {
      const response = await request('api/cli/control', { op, args });
      assert.equal(response.isError, false, JSON.stringify(response));
      return toolResult(response);
    };
    const phases: Record<string, number> = { metadataMs: performance.now() - at };
    assert.equal((await request('healthz')).pid, child.pid);
    phases.healthMs = performance.now() - at;
    const lease = randomUUID();
    await request('api/runtime/lease', { id: lease, kind: 'desktop', pid: process.pid });
    shutdown = () => request('api/runtime/shutdown', { id: lease });
    phases.leaseMs = performance.now() - at;
    await call('guide', { op: 'receipt' });
    phases.guideMs = performance.now() - at;
    await call('runtime_metrics');
    phases.queryMs = performance.now() - at;
    console.log('Core readiness phases:', phases);
    return { stop, call, request, metadataWallAt: wallAt + phases.metadataMs, metadataAt: at + phases.metadataMs, readinessMs: performance.now() - at };
  } catch (error) { await stop(); throw error; }
}

test('real Core serves health, leases, guide and query before realistic retained-state migration publishes', { timeout: 120000 }, async () => {
  // Regression: ax-c398fbae blocked guide and pending-owner queries during installed-scale migration and rewrote unchanged bindings on restart.
  execFileSync('cargo', ['build', '--locked', '--quiet', '-p', 'contract-fixture', '--target-dir', target], { stdio: 'inherit' });
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-index-runtime-'));
  const state = path.join(directory, 'state');
  let core: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const fixture = await writeRetainedState(state);
    await writeFile(path.join(directory, 'index-gate'), 'hold background migration');
    console.log('Retained fixture bytes:', fixture.totals);
    core = await start(directory);
    assert.ok(core.readinessMs < 5000, `readiness: ${core.readinessMs} ms`);
    const owners = ['notifications/tasks', '', 'agents/requests'];
    for (const owner of owners) assert.equal(await json(path.join(state, owner, '.activity-index/current.json')), undefined, 'Readiness must precede every index publish');
    const coreMetadataWallAt = core.metadataWallAt;
    const rebuilding = performance.now();
    const latencies: Record<string, number[]> = { guide: [], unrelated: [], pending: [], published: [] };
    const pendingCodes: string[] = [];
    let finished = false;
    const sample = async (name: string, read: () => Promise<any>) => {
      const at = performance.now();
      const result = await read();
      const elapsed = performance.now() - at;
      latencies[name].push(elapsed);
      if (elapsed > 100) console.log(JSON.stringify({ slow: name, startMs: at - rebuilding, elapsedMs: elapsed }));
      return result;
    };
    const pending = async () => {
      const result = await sample('pending', () => core!.request('api/tasks', undefined, true));
      pendingCodes.push(JSON.stringify(result));
    };
    // Keep requests outstanding throughout actual rebuild and durable publication.
    const load = async (name: string, read: () => Promise<any>) => {
      while (!finished) { await sample(name, read); await pause(20); }
    };
    await rm(path.join(directory, 'index-gate'));
    let codexPublished = false;
    const pendingRequests = async () => { while (!codexPublished && !finished) { await pending(); await pause(20); } };
    const requests = [pendingRequests(), load('guide', () => core!.call('guide', { op: 'receipt' })), load('unrelated', () => core!.call('runtime_metrics'))];
    const publish: Record<string, number> = {};
    try {
      const observations = await Promise.allSettled(owners.map(async owner => {
        await eventually(() => json(path.join(state, owner, '.activity-index/current.json')), 20000);
        publish[owner || 'codex'] = performance.now() - rebuilding;
        if (!owner) codexPublished = true;
        if (owner === 'notifications/tasks') await eventually(async () => {
          const result = await sample('published', () => core!.request('api/cli/control', { op: 'notify_status', args: { threadId: 'unrelated-fixture-thread' } }));
          if (result.isError) { assert.ok(JSON.stringify(result).includes('INDEX_NOT_READY')); return undefined; }
          return true;
        });
      }));
      for (const observation of observations) if (observation.status === 'rejected') throw observation.reason;
    } finally { finished = true; await Promise.all(requests); }
    const metrics = await core.call('runtime_metrics');
    assert.equal((await core.call('receipt', { requestId: fixture.ids[0] })).state, 'completed');
    console.log(JSON.stringify({ publish, metadataToCodexMs: rebuilding - core.metadataAt + publish.codex, latencies: Object.fromEntries(Object.entries(latencies).map(([key, values]) => [key, { samples: values.length, maxMs: Math.max(...values) }])), pendingErrors: [...new Set(pendingCodes)], seed: { receipts: metrics.cost.receiptSeed, notifications: metrics.cost.notificationSeed } }));
    // Wait for one real observer pass, then compare every canonical byte and mtime.
    await eventually(async () => (await core!.call('runtime_metrics')).notificationObserve.totals.completedPasses > 0 ? true : undefined);
    const publication = (await indexPublications(state)).find(row => row.profile.owner === 'receipts' && row.profile.rows === fixture.ids.length && row.profile.mode === 'rebuild');
    assert.ok(publication);
    const receiptReadyAfterMetadataMs = publication.at - coreMetadataWallAt;
    console.log(JSON.stringify({ receiptReadyAfterMetadataMs, receiptRebuild: publication.profile }));
    await core.stop(); core = undefined;
    const before = await canonicalSnapshot(state);
    core = await start(directory);
    await eventually(async () => (await core!.call('runtime_metrics')).notificationObserve.totals.completedPasses > 0 ? true : undefined);
    const adopted = await core.call('runtime_metrics');
    const tasks = await core.request('api/tasks');
    assert.ok(tasks.records.length > 0);
    const reused = await core.call('runtime_metrics');
    assert.deepEqual(reused.cost.receiptAdopt, adopted.cost.receiptAdopt);
    assert.equal(reused.cost.receiptProjection.bytesParsed, 0);
    await core.stop(); core = undefined;
    const after = await canonicalSnapshot(state);
    const rewritten = [...before].filter(([key, value]) => after.get(key)?.mtime !== value.mtime || after.get(key)?.bytes !== value.bytes);
    console.log(JSON.stringify({ canonicalFiles: before.size, rewritten: rewritten.length, adopt: { receipts: adopted.cost.receiptAdopt, notifications: adopted.cost.notificationAdopt }, receiptSeed: adopted.cost.receiptSeed }));
    assert.ok(receiptReadyAfterMetadataMs < 5000, `receipt ready after metadata: ${receiptReadyAfterMetadataMs} ms`);
    for (const [name, values] of Object.entries(latencies)) {
      assert.ok(values.length > 0, `${name} has concurrent samples`);
      assert.ok(Math.max(...values) < 200, `${name} max latency: ${Math.max(...values)} ms`);
    }
    assert.ok(pendingCodes.some(code => code.includes('INDEX_NOT_READY')));
    assert.equal(after.size, before.size);
    assert.equal(rewritten.length, 0, 'Idle restart preserves canonical bytes and mtimes');
    assert.equal(adopted.cost.receiptAdopt.passes, 1);
    assert.equal(adopted.cost.receiptAdopt.rowsVisited, fixture.ids.length + 52);
    assert.ok(adopted.cost.receiptAdopt.bytesRead < fixture.totals.receipts + fixture.totals.agents);
    assert.equal(adopted.cost.receiptSeed.bytesParsed, 0);
    assert.equal(adopted.cost.notificationSeed.bytesParsed, 0);
  } finally {
    try {
      await core?.stop();
      for (const log of await readdir(path.join(state, 'logs'))) {
        for (const line of (await readFile(path.join(state, 'logs', log), 'utf8')).split('\n').filter(Boolean)) {
          const row = JSON.parse(line);
          if (row.msg.startsWith('Index startup ') || row.msg.startsWith('Source history migration completed')) console.log(row.msg);
        }
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
      execFileSync(process.execPath, ['tooling/prune-build-cache.mjs', '--keep=target/debug'], { stdio: 'inherit' });
    }
  }
});
