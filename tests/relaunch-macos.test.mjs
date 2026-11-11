import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';

test('macOS relaunch waits for the old Desktop before handing arguments to LaunchServices', { skip: process.platform !== 'darwin' }, async () => {
  // Regression: app restart retained stale Core LAN state and relaunched before the old Desktop exited.
  const oldDesktop = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: ['pipe', 'ignore', 'inherit'] });
  const oldExit = once(oldDesktop, 'exit');
  const args = ['-a', '/Applications/Example App.app', '--args', '--state-dir', '/tmp/example state;$(echo unsafe)'];
  const probe = `let alive=true;try{process.kill(Number(process.argv[1]),0)}catch{alive=false}process.stdout.write(JSON.stringify({alive,args:process.argv.slice(2)}))`;
  const handoff = spawn('/bin/sh', [fileURLToPath(new URL('../native/src/relaunch-macos.sh', import.meta.url)), String(oldDesktop.pid), process.execPath, '-e', probe, '--', String(oldDesktop.pid), ...args]);
  const handoffExit = once(handoff, 'exit');
  let output = '';
  handoff.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; });
  try {
    await setTimeout(250);
    assert.equal(handoff.exitCode, null);
    oldDesktop.stdin.end();
    await oldExit;
    const [code] = await handoffExit;
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { alive: false, args });
  } finally {
    if (oldDesktop.exitCode === null && oldDesktop.signalCode === null) oldDesktop.kill();
    if (handoff.exitCode === null && handoff.signalCode === null) handoff.kill();
    await Promise.all([oldExit, handoffExit]);
  }
});
