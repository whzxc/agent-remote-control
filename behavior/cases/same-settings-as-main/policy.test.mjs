import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeControl } from '../../../tests/helpers/native-control.ts';

const then = 'same-settings-as-main/model-from-policy';
// The native endpoint records the actual submitted turn independently of the ARC receipt.
const server = `
  import { createInterface } from 'node:readline';
  import { randomUUID } from 'node:crypto';
  const threads = new Map();
  for await (const line of createInterface({input: process.stdin})) {
    const {id, method, params} = JSON.parse(line);
    if (id === undefined) continue;
    let result = {data: []};
    if (method === 'thread/start') {
      const thread = {id: randomUUID(), cwd: params.cwd, turns: [], status: {type: 'idle'}};
      threads.set(thread.id, thread);
      result = {thread};
    }
    if (method === 'turn/start') {
      const turn = {id: randomUUID(), status: 'completed', items: [], submitted: params};
      threads.get(params.threadId).turns.push(turn);
      result = {turn};
    }
    if (method === 'thread/read') result = {thread: threads.get(params.threadId)};
    if (method === 'thread/turns/list') result = {data: threads.get(params.threadId).turns, nextCursor: null};
    console.log(JSON.stringify({id, result}));
  }
`;

test(then, async t => {
  // Contract: a dispatch submits the selected model, effort and speed to the native turn.
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-policy-case-'));
  const state = path.join(directory, 'state');
  const defaults = {model: 'fixture-policy', effort: 'low', serviceTier: 'priority'};
  const packed = {model: 'fixture-pack', effort: 'high', serviceTier: 'default'};
  const explicit = {model: 'fixture-explicit', effort: 'medium', serviceTier: 'priority'};
  const fixture = await nativeControl(server, {HOME: directory, CODEX_HOME: directory, ARC_STATE_DIR: state});
  try {
    const saved = await fixture.completed('write', {path: path.join(state, 'dispatch-policy.json'),
      content: JSON.stringify({codex: defaults})});
    if (saved.state !== 'completed') throw Error('Policy setup failed: ' + JSON.stringify(saved));
    await fixture.api('task-settings', {autoOpenCodex: false}, 'PUT');
    const name = 'case-defaults';
    const pack = await fixture.call('dispatch_pack_update', {name, expectedPackHash: null,
      pack: {agent: 'codex', summary: 'Policy case', prompt: 'Return a marker.', ...packed}});
    if (!pack.packHash) throw Error('Pack setup failed: ' + JSON.stringify(pack));
    for (const [id, args, expected] of [
      ['policy-omitted', {}, defaults],
      ['policy-pack', {pack: name}, packed],
      ['policy-explicit', {pack: name, ...explicit}, explicit],
    ]) {
      const receipt = await fixture.completed('codex_create', {thread: {cwd: directory}, prompt: id, ...args});
      assert.equal(receipt.state, 'completed', then + ' ' + JSON.stringify(receipt));
      const rows = await fixture.call('codex_query', {method: 'thread/turns/list', params: {threadId: receipt.threadId}});
      const turn = rows.data.find(row => row.id === receipt.turnId).submitted;
      assert.equal(turn.threadId, receipt.threadId, then);
      for (const key of Object.keys(expected)) {
        assert.equal(receipt.dispatch[key], expected[key], then + ' receipt ' + key);
        assert.equal(turn[key], expected[key], then + ' submitted ' + key);
      }
      t.diagnostic(id);
    }
  } finally {
    await fixture.close();
    await rm(directory, {recursive: true, force: true});
  }
});
