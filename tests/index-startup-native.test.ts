import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeRetainedState } from './helpers/index-state.ts';

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
  const at = performance.now();
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
    const request = async (route: string, body?: any) => {
      const response = await fetch(`http://127.0.0.1:${endpoint.port}/${route}`, {
        method: body === undefined ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value as any;
    };
    const call = async (op: string, args = {}) => {
      const response = await request('api/cli/control', { op, args });
      assert.equal(response.isError, false, JSON.stringify(response));
      return response.structuredContent.result;
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
    return { stop, call, request, readinessMs: performance.now() - at };
  } catch (error) { await stop(); throw error; }
}

test('real Core serves health, leases, guide and query before realistic retained-state migration publishes', { timeout: 120000 }, async () => {
  // Regression: de8da748 still migrated 44 MB of root receipts and dirtied every key before opening the Core listener, exceeding 30 seconds.
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
    const rebuilding = performance.now();
    await rm(path.join(directory, 'index-gate'));
    for (const owner of owners) {
      await eventually(() => json(path.join(state, owner, '.activity-index/current.json')));
      // A published owner is immediately queryable while other owners may still rebuild.
      if (owner === 'notifications/tasks') await core.call('notify_status', { all: true });
    }
    const migrationMs = performance.now() - rebuilding;
    const tasks = await core.request('api/tasks');
    assert.ok(tasks.records.length > 0);
    assert.ok(migrationMs < 12000, `migration: ${migrationMs} ms`);
    const metrics = await core.call('runtime_metrics');
    assert.ok(metrics.cost.receiptSeed.bytesParsed >= fixture.totals.receipts + fixture.totals.agents);
    assert.ok(metrics.cost.notificationSeed.bytesParsed >= fixture.totals.bindings);
    assert.equal((await core.call('receipt', { requestId: fixture.ids[0] })).state, 'completed');
    console.log(JSON.stringify({ readinessMs: core.readinessMs, migrationMs, seed: { receipts: metrics.cost.receiptSeed, notifications: metrics.cost.notificationSeed } }));
    await core.stop(); core = undefined;
    const restarted = await start(directory); core = restarted;
    await eventually(async () => {
      const metrics = await restarted.call('runtime_metrics');
      return metrics.cost.receiptAdopt.rowsVisited >= 7884 && metrics.cost.notificationAdopt.rowsVisited >= 1078 ? metrics : undefined;
    });
    const adopted = await core.call('runtime_metrics');
    assert.equal(adopted.cost.receiptSeed.bytesParsed, 0);
    assert.equal(adopted.cost.notificationSeed.bytesParsed, 0);
    assert.equal((await core.call('receipt', { requestId: fixture.ids[0] })).state, 'completed');
    console.log(JSON.stringify({ restartReadinessMs: core.readinessMs, adopt: { receipts: adopted.cost.receiptAdopt, notifications: adopted.cost.notificationAdopt } }));
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
