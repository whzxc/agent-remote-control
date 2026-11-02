import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { testEnvironment } from './test-environment.mjs';
import { testFiles } from './test-suites.mjs';

const budgetError = () => Object.assign(new Error('Daily tests exceeded the 30-second budget. Move slow runtime coverage to test:extended.'), { code: 'TEST_BUDGET_EXCEEDED' });

// Daily checks share one wall-clock budget, including policy checks and startup.
export function runTestCommand(file, args, { env = testEnvironment(), timeoutMs } = {}) {
  if (timeoutMs !== undefined && timeoutMs <= 0) return Promise.reject(budgetError());
  const deadline = timeoutMs === undefined ? Infinity : performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: 'inherit', detached: process.platform !== 'win32' });
    let expired = false;
    let interrupted = false;
    const stop = () => {
      expired = true;
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on('error', () => child.kill());
      } else {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
      }
    };
    const interrupt = () => { interrupted = true; stop(); };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    const timer = timeoutMs === undefined ? undefined : setTimeout(stop, Math.max(0, timeoutMs));
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => {
      clearTimeout(timer);
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      if (interrupted) reject(new Error('Tests interrupted.'));
      else if (expired || performance.now() >= deadline) reject(budgetError());
      else if (code === 0) resolve();
      else reject(new Error(`${file} exited ${code}`));
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--extended')) throw new Error('Usage: npm test | npm run test:extended');
  const extended = args[0] === '--extended';
  if (extended) (await import('./heavy-build.mjs')).enterHeavyBuild();
  const started = performance.now();
  // Leave one second for npm startup and process teardown.
  const deadline = extended ? undefined : started + 29_000;
  const env = testEnvironment();
  if (extended) env.ARC_TEST_BINARY = path.resolve(process.env.CARGO_TARGET_DIR || 'target', 'debug', process.platform === 'win32' ? 'arc.exe' : 'arc');
  const run = (file, argv) => runTestCommand(file, argv, { env, timeoutMs: deadline === undefined ? undefined : deadline - performance.now() });
  await run(process.execPath, ['tooling/check-tests.mjs']);
  if (extended) {
    try {
      await run('cargo', ['test', '--locked', '--manifest-path', 'native/Cargo.toml', '--lib']);
      if (process.platform === 'darwin') await run('cargo', ['test', '--locked', '-p', 'agent-remote-control', '--bin', 'agent-remote-control-desktop', 'src_conversations']);
      await run('cargo', ['build', '--locked', '-p', 'arc-core', '--bin', 'arc']);
      await run(process.execPath, ['--test', '--test-concurrency=4', ...await testFiles(true)]);
    } finally { await run(process.execPath, ['tooling/prune-build-cache.mjs', '--keep=target/debug']); }
  } else {
    await run(process.execPath, ['--test', '--test-concurrency=4', ...await testFiles()]);
  }
  console.log(`${extended ? 'Extended' : 'Daily'} tests passed in ${((performance.now() - started) / 1000).toFixed(2)}s${extended ? '' : ' (30s budget)'}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
