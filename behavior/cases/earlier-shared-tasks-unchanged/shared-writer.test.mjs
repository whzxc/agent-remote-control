import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { nativeControl } from '../../../tests/helpers/native-control.ts';

const fixtureServer = new URL('../../../tests/fixtures/codex-app-server.mjs', import.meta.url);
const assertion = 'earlier-shared-tasks-unchanged/still-works';

for (const minor of [163, 166]) {
  test('Shared writer survives ARC restart with Codex 0.' + minor + '.0', async t => {
    // Contract: the holder reported for an existing native thread survives ARC recovery.
    const cleanup = [];
    t.after(async () => {
      for (const close of cleanup.reverse()) await close();
    });
    const executable = process.env['CODEX_' + minor];
    if (!executable) throw Error('Supply CODEX_' + minor + ' as an absolute binary path');
    const version = execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
    if (version !== 'codex-cli 0.' + minor + '.0') throw Error('Incorrect binary: ' + version);
    const home = await realpath(await mkdtemp('/tmp/arc-own-'));
    cleanup.push(() => rm(home, { recursive: true, force: true }));
    const env = { HOME: home, CODEX_HOME: home, TMPDIR: home, PATH: '/usr/bin:/bin' };
    const endpoint = path.join(home, 'app-server-control/app-server-control.sock');
    await mkdir(path.dirname(endpoint));
    const server = spawn(executable, ['app-server', '--listen', 'unix://' + endpoint], {
      env, cwd: home, stdio: ['ignore', 'ignore', 'inherit'],
    });
    const exited = once(server, 'exit');
    cleanup.push(async () => {
      server.kill('SIGTERM');
      const timeout = setTimeout(() => server.kill('SIGKILL'), 3000);
      try { await exited; } finally { clearTimeout(timeout); }
    });
    for (let i = 0; i < 100 && !(await stat(endpoint).catch(() => null)); i++) await delay(50);
    const peer = new WebSocket('ws+unix://' + endpoint + ':/rpc');
    cleanup.push(() => peer.terminate());
    await once(peer, 'open');
    let sequence = 0;
    async function rpc(method, params) {
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(method + ' timed out')), 5000);
        function receive(bytes) {
          const message = JSON.parse(bytes);
          if (message.id !== id) return;
          clearTimeout(timer);
          peer.off('message', receive);
          if (message.error) reject(Error(JSON.stringify(message.error)));
          else resolve(message.result);
        }
        peer.on('message', receive);
        peer.send(JSON.stringify({ id, method, params }));
      });
    }
    const init = await rpc('initialize', { clientInfo: { name: 'case-witness', version: '1' },
      capabilities: { experimentalApi: true } });
    if (await realpath(init.codexHome) !== home) throw Error('Unexpected native home');
    peer.send(JSON.stringify({ method: 'initialized' }));
    const { thread } = await rpc('thread/start', { cwd: home, config: { thread_unload_delay_secs: 0 } });
    await rpc('thread/name/set', { threadId: thread.id, name: 'Legacy writer witness' });

    const fixture = await nativeControl('await import(' + JSON.stringify(fixtureServer.href) + ')', {
      HOME: home, CODEX_HOME: home, ARC_FIXTURE_DATA: home,
      ARC_FIXTURE_OPEN_FILE: path.join(home, 'navigation'),
    });
    cleanup.push(() => fixture.close());
    const observe = () => fixture.call('codex_owner', { threadId: thread.id });
    for (const stage of ['before restart', 'after restart']) {
      if (stage === 'after restart') await fixture.restart();
      const owner = await observe();
      assert.equal(owner.state, 'held', assertion + ' ' + stage + ': ' + JSON.stringify(owner));
      assert.ok(owner.processes.some(row => row.pid === server.pid), assertion + ' same writer');
    }
    const release = await rpc('thread/unsubscribe', { threadId: thread.id });
    assert.equal(release.status, 'unsubscribed', assertion + ' witness retained subscription');
    // Calibrate the shared daemon given independently of the installed exit deadline.
    await delay(31000);
    const state = (await observe()).state;
    console.log(JSON.stringify({ version, threadId: thread.id, afterRelease: state }));
    if (state !== (minor === 163 ? 'held' : 'unheld')) throw Error('Shared policy control: ' + state);
  });
}
