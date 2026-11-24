import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { nativeControl } from '../../../tests/helpers/native-control.ts';

const rule = 'foreign-holder-reported';
const upstream = `
  import { createInterface } from 'node:readline';
  import { randomUUID } from 'node:crypto';
  import { existsSync } from 'node:fs';
  import path from 'node:path';
  const turn = {id: randomUUID(), status: 'completed', items: []};
  for await (const line of createInterface({input: process.stdin})) {
    const {id, method, params} = JSON.parse(line);
    if (id === undefined) continue;
    let result = {};
    if (method === 'thread/start') result = {thread: {id: randomUUID(), cwd: params.cwd}};
    if (method === 'turn/start') result = {turn};
    if (method === 'thread/read') {
      const external = existsSync(path.join(process.env.CODEX_HOME, 'thread-writer-locks', params.threadId + '.lock'));
      result = {thread: {id: params.threadId, cwd: process.env.CODEX_HOME, status: {type: external ? 'notLoaded' : 'idle'}}};
    }
    if (method === 'thread/turns/list') result = {data: [turn], nextCursor: null};
    console.log(JSON.stringify({id, result}));
  }
`;

// A real local terminal session, with a kernel-assigned controlling tty, owns
// the test lock. Its command channel remains usable after the owner query.
const terminal = `
import fcntl, os, sys, termios
master, slave = os.openpty()
os.setsid()
fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
with open(sys.argv[1], "a") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    print(os.ttyname(slave), flush=True)
    for command in sys.stdin:
        print("still here", flush=True)
`;

test('codex_owner identifies the process and local terminal holding a dispatched task', {
  skip: process.platform !== 'darwin',
}, async t => {
  // Contract: codex_owner attributes the writer and gives reachable recovery for a terminal-owned task.
  const directory = await mkdtemp('/tmp/arc-handback-');
  t.after(() => rm(directory, {recursive: true, force: true}));
  const lockDir = path.join(directory, 'thread-writer-locks');
  await mkdir(lockDir);
  const fixture = await nativeControl(upstream, {
    HOME: directory, USERPROFILE: directory, XDG_CONFIG_HOME: directory, CODEX_HOME: directory,
    ARC_FIXTURE_OPEN_FILE: path.join(directory, 'navigation'),
  });
  t.after(() => fixture.close());
  await fixture.api('task-settings', {autoOpenCodex: false}, 'PUT');
  const created = await fixture.completed('codex_create', {thread: {cwd: directory}, prompt: 'Terminal handoff'});
  if (!created.threadId || created.state !== 'completed') throw Error('Dispatch setup failed: ' + JSON.stringify(created));
  const threadId = created.threadId;
  const holder = spawn('python3', ['-u', '-c', terminal, path.join(lockDir, threadId + '.lock')], {
    cwd: directory, stdio: ['pipe', 'pipe', 'inherit'],
  });
  const exited = once(holder, 'close');
  t.after(async () => { holder.stdin.end(); await exited; });
  const lines = createInterface({input: holder.stdout})[Symbol.asyncIterator]();
  const tty = (await lines.next()).value;
  if (!tty?.startsWith('/dev/')) throw Error('Terminal holder did not acquire its test lock');
  const owner = await fixture.call('codex_owner', {threadId});
  const evidence = JSON.stringify(owner);
  holder.stdin.write('ping\n');
  assert.equal((await lines.next()).value, 'still here', rule + '/holder-untouched');

  const {next, ...attribution} = owner;
  assert.ok(next, rule + '/steps-workable recovery instructions: ' + evidence);
  assert.notEqual(next.op, 'task_open', rule + '/steps-workable no Desktop exists: ' + evidence);
  holder.stdin.end();
  await exited;
  if (next.via === 'query') {
    const result = await fixture.call(next.op, next.args);
    assert.ok(!result.error, rule + '/steps-workable ' + JSON.stringify(result));
  }
  const reprobe = await fixture.call('codex_owner', {threadId});
  assert.equal(reprobe.state, 'unheld', rule + '/steps-workable');

  const source = JSON.stringify(attribution);
  assert.ok(source.includes(String(holder.pid)) || /python/i.test(source), rule + '/holder-named process: ' + evidence);
  assert.ok(source.includes(path.basename(tty)) || /terminal|pseudo.?tty|pty session/i.test(source),
    rule + '/holder-named local terminal origin: ' + evidence);
});
