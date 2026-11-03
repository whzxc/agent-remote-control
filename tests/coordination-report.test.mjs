import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { reportLifecycle } from '../tooling/coordination-report.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-observer-report-'));
  try {
    await mkdir(path.join(directory, 'app'));
    await writeFile(path.join(directory, 'app/native.json'), JSON.stringify({ port: 1, pid: 10, instance: 'fixture', token: 'fixture-token' }));
    await run(directory);
  } finally { await rm(directory, { recursive: true, force: true }); }
}
const body = { transitionId: 'fixture-transition', kind: 'lane.created', repository: '/fixture', lane: 'fixture' };

test('Core down is missing coverage and leaves tooling completion independent', async () => {
  // Contract: local tooling reports missing coordination coverage when Core cannot be reached.
  await fixture(async directory => {
    const result = await reportLifecycle(body, { stateDirectory: directory, request: async () => { throw new Error('unreachable'); } });
    assert.equal(result.coverage, 'missing');
    assert.equal(result.transitionId, body.transitionId);
    assert.equal(JSON.stringify(result).includes('fixture-token'), false);
  });
});
test('local lifecycle requires identity and transition readback', async () => {
  // Contract: a successful local POST alone never establishes observed lifecycle coverage.
  await fixture(async directory => {
    const request = async url => new Response(JSON.stringify(url.endsWith('healthz')
      ? { instance: 'fixture', pid: 10, owner: 'core' }
      : { state: 'accepted' }), { status: 200 });
    assert.equal((await reportLifecycle(body, { stateDirectory: directory, request })).coverage, 'missing');
    const confirmed = async url => new Response(JSON.stringify(url.endsWith('healthz')
      ? { instance: 'fixture', pid: 10, owner: 'core' }
      : { transitionId: body.transitionId, kind: body.kind, state: 'observed' }), { status: 200 });
    assert.equal((await reportLifecycle(body, { stateDirectory: directory, request: confirmed })).coverage, 'readback-confirmed');
  });
});

test('shared action warnings survive lifecycle readback without blocking completion', async () => {
  // Contract: local coordination-conflicts and observed lifecycle responses expose advisory claims without changing action success.
  const { reportConflicts, beginLifecycle } = await import('../tooling/coordination-report.mjs');
  await fixture(async directory => {
    const conflicts = [{ noticeId: 'notice-one', resource: 'project:fixture/main', state: 'active', lastActiveAt: '2026-10-01T00:00:00Z', inactivityAgeSeconds: 120 }];
    let transition;
    const request = async (url, options) => {
      if (url.endsWith('healthz')) return Response.json({ instance: 'fixture', pid: 10, owner: 'core' });
      if (url.endsWith('/conflicts')) return Response.json({ conflicts, conflictCoverage: 'observed' });
      if (url.endsWith('/observe')) { transition = JSON.parse(options.body); return Response.json({ state: 'observed' }); }
      return Response.json({ transitionId: transition.transitionId, kind: transition.kind, state: 'observed', conflicts, conflictCoverage: 'observed' });
    };
    const options = { stateDirectory: directory, request };
    assert.deepEqual((await reportConflicts(body, options)).conflicts, conflicts);
    const finish = await beginLifecycle(path.join(directory, 'outbox'), { ...body, kind: 'lane.landed' }, options);
    const result = await finish(true);
    assert.equal(result.coverage, 'readback-confirmed');
    assert.deepEqual(result.conflicts, conflicts);
    assert.equal(result.conflictCoverage, 'observed');
    assert.equal(JSON.stringify(result).includes('fixture-token'), false);
    const unavailable = await reportConflicts(body, { stateDirectory: directory, request: async () => { throw new Error('offline'); } });
    assert.equal(unavailable.conflictCoverage, 'unknown');
  });
});

test('lane lifecycle forwards its command origin through preflight and observation', async () => {
  // Regression: ax-d7a7872f worktree handoff lost the command initiator and reported its own notices as conflicts.
  const { beginLifecycle } = await import('../tooling/coordination-report.mjs');
  const previous = process.env.ARC_TOOLING_ORIGIN;
  process.env.ARC_TOOLING_ORIGIN = 'core-issued-command-token';
  try {
    await fixture(async directory => {
      let transition;
      const request = async (url, options) => {
        if (url.endsWith('healthz')) return Response.json({ instance: 'fixture', pid: 10, owner: 'core' });
        if (options.method === 'POST') {
          const payload = JSON.parse(options.body);
          assert.equal(payload.toolingOrigin, 'core-issued-command-token');
          if (url.endsWith('/observe')) transition = payload;
          return Response.json({ conflicts: [], conflictCoverage: 'observed' });
        }
        return Response.json({ transitionId: transition.transitionId, kind: transition.kind, state: 'observed', conflicts: [], conflictCoverage: 'observed' });
      };
      for (const kind of ['lane.created', 'lane.removed', 'lane.landed']) {
        const finish = await beginLifecycle(path.join(directory, 'outbox'), { ...body, kind }, { stateDirectory: directory, request });
        const result = await finish();
        assert.equal(result.coverage, 'readback-confirmed');
        assert.deepEqual(result.conflicts, []);
      }
    });
  } finally {
    if (previous === undefined) delete process.env.ARC_TOOLING_ORIGIN;
    else process.env.ARC_TOOLING_ORIGIN = previous;
  }
});
