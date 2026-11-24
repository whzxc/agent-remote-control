import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { toolResult } from '../../../tooling/mcp-result.mjs';
import { nativeControl } from '../../../tests/helpers/native-control.ts';

const then = 'running-work-survives-arc-restart/follow-ups-work';
const upstream = new URL('../../../tests/fixtures/codex-app-server.mjs', import.meta.url);

test(then, async t => {
  // Recurring bug class: retry-replay notification retries and restart can duplicate or lose a completion.
  const directory = await mkdtemp(path.join(tmpdir(), 'arc-completion-'));
  const attempts = [];
  let retryTurn;
  const receiver = createServer(async (req, res) => {
    const bytes = [];
    for await (const chunk of req) bytes.push(chunk);
    const body = JSON.parse(Buffer.concat(bytes));
    if (body.type === 'verification') {
      res.end(JSON.stringify({challenge: body.challenge}));
      return;
    }
    const refuse = body.data.turnId === retryTurn && !attempts.some(a => a.turnId === retryTurn);
    attempts.push({...body.data, eventId: body.eventId, header: req.headers['webhook-id']});
    res.writeHead(refuse ? 503 : 204).end();
  });
  receiver.listen(0, '127.0.0.1');
  await once(receiver, 'listening');
  const url = 'http://127.0.0.1:' + receiver.address().port + '/callback';
  let fixture;
  try {
    fixture = await nativeControl('await import(' + JSON.stringify(upstream.href) + ')', {
      HOME: directory, CODEX_HOME: directory, ARC_FIXTURE_DATA: directory, ARC_FIXTURE_WEBHOOK: url,
    });
    await fixture.api('task-settings', {autoOpenCodex: false}, 'PUT');
    const token = randomBytes(32).toString('hex');
    const id = 'case-source';
    const ingress = await fixture.api('ingress', {id, name: 'Case source', controlSource: 'custom',
      enabled: true, transport: 'https', auth: 'bearer', bearerToken: token, toolPolicy: 'all',
      config: {httpsProvider: 'custom', proxyMode: 'direct', httpsHost: '127.0.0.1', httpsUrl: 'https://fixture.example/mcp'}});
    async function startIngress() {
      const started = await fixture.api('ingress/' + id + '/start', {});
      if (started.error) throw Error('Fixture ingress start: ' + JSON.stringify(started));
    }
    await startIngress();
    async function rpc(method, params) {
      const response = await fetch('http://127.0.0.1:' + ingress.config.httpsPort + '/mcp', {
        method: 'POST', headers: {'content-type': 'application/json', accept: 'application/json',
          authorization: 'Bearer ' + token},
        body: JSON.stringify({jsonrpc: '2.0', id: randomUUID(), method, params}),
        signal: AbortSignal.timeout(15000),
      });
      const value = await response.json();
      if (!value.result) throw Error(JSON.stringify(value.error));
      return value.result;
    }
    const call = async (name, op, args) => toolResult(await rpc('tools/call', {name, arguments: {op, args}}));
    const subscription = await rpc('events/subscribe', {name: 'notification',
      arguments: {op: 'task_status', args: {}}, ttlMs: 600000,
      delivery: {mode: 'webhook', url, secret: 'whsec_' + randomBytes(32).toString('base64')}});
    async function dispatch(op, args) {
      let value = await call('act', op, {...args, purpose: 'self-test', notify: null});
      const end = Date.now() + 15000;
      while (['reserved', 'executing'].includes(value.state) && Date.now() < end) {
        await delay(50);
        value = await call('query', 'receipt', {requestId: value.requestId});
      }
      if (value.state !== 'completed') throw Error(JSON.stringify(value));
      return value;
    }
    const tasks = [];
    for (const title of ['normal-first-ack', 'retry-completion']) {
      tasks.push(await dispatch('codex_create', {title, prompt: title,
        model: 'fixture-dispatch-queue', thread: {cwd: directory}}));
    }
    retryTurn = tasks[1].turnId;
    await fixture.restart();
    // The fixture replaces its front door too. Rebind its loopback listener.
    await fixture.api('ingress/' + id + '/stop', {});
    await startIngress();
    for (const task of tasks) {
      await fixture.completed('codex_call', {method: 'fixture/finish-turn', params: {threadId: task.threadId}});
    }
    for (const [index, task] of tasks.entries()) {
      const matching = row => row.threadId === task.threadId && row.turnId === task.turnId && row.kind === 'completed';
      const end = Date.now() + 45000;
      let rows;
      do {
        const status = await call('query', 'notify_status', {target: subscription.id, threadId: task.threadId, view: 'full'});
        rows = status.deliveries?.filter(matching) ?? [];
        if (rows.some(r => r.state === 'callback-accepted')) break;
        await delay(250);
      } while (Date.now() < end);
      assert.equal(rows.length, 1, then + ' completion delivery records: ' + JSON.stringify(rows));
      assert.equal(rows[0].state, 'callback-accepted', then);
      const marker = 'follow-up-' + randomUUID();
      const sent = await dispatch('codex_send', {threadId: task.threadId, prompt: marker});
      const turns = await fixture.call('codex_query', {method: 'thread/turns/list', params: {
        threadId: task.threadId, sortDirection: 'desc', limit: 1}});
      assert.equal(turns.data[0].id, sent.turnId, then);
      assert.ok(turns.data[0].input.some(item => item.text === marker), then);
      if (!index) await delay(11000);
      const posts = attempts.filter(matching);
      if (index) assert.ok(posts.length >= 2, then + ' actual delivery retry');
      else assert.equal(posts.length, 1, then + ' normally acknowledged arrivals');
      assert.ok(rows[0].eventId, then);
      for (const post of posts) {
        assert.equal(post.eventId, rows[0].eventId, then);
        assert.equal(post.header, post.eventId, then);
      }
      t.diagnostic(JSON.stringify({trial: index ? 'retry-completion' : 'normal-first-ack',
        recorded: rows.length, arrivals: posts.length, eventId: rows[0].eventId, followUp: sent.turnId}));
    }
  } finally {
    if (fixture) await fixture.close();
    await new Promise(resolve => receiver.close(resolve));
    await rm(directory, {recursive: true, force: true});
  }
});
