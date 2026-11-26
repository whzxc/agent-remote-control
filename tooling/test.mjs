import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { testEnvironment } from './test-environment.mjs';
import { startupBenchmark, testFiles } from './test-suites.mjs';
import { buildGoTestBinaries, testGo } from './go-test.mjs';

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
  const selected = args[0] === '--native' ? args.slice(1) : [];
  if (args.length && !(args.length === 1 && args[0] === '--extended') && !(selected.length && selected.every(file => /^tests\/[\w-]+\.test\.ts$/.test(file)))) {
    throw new Error('Usage: npm test | npm run test:extended | node tooling/test.mjs --native tests/<name>.test.ts');
  }
  const extended = args[0] === '--extended';
  const native = extended || selected.length > 0;
  if (native) (await import('./heavy-build.mjs')).enterHeavyBuild();
  const started = performance.now();
  // Leave one second for npm startup and process teardown.
  const deadline = native ? undefined : started + 29_000;
  const env = testEnvironment();
  const run = (file, argv) => runTestCommand(file, argv, { env, timeoutMs: deadline === undefined ? undefined : deadline - performance.now() });
  await run(process.execPath, ['tooling/check-tests.mjs']);
  await run(process.execPath, ['tooling/check-ui-styles.mjs']);
  if (extended) await testGo(run);
  if (native) {
    env.CGO_ENABLED = '0';
    env.ARC_TEST_TARGET_DIR = path.resolve('dist/native-tests');
    Object.assign(env, await buildGoTestBinaries(run, env));
    const files = extended ? await testFiles(true) : selected;
    // Run the startup benchmark without other process fixtures competing for CPU.
    if (files.includes(startupBenchmark)) await run(process.execPath, ['--test', startupBenchmark]);
    const others = files.filter(file => file !== startupBenchmark);
    if (others.length) await run(process.execPath, ['--test', '--test-concurrency=4', ...others]);
  } else {
    await run(process.execPath, ['--test', '--test-concurrency=4', ...await testFiles()]);
  }
  console.log(`${native ? 'Native' : 'Daily'} tests passed in ${((performance.now() - started) / 1000).toFixed(2)}s${native ? '' : ' (30s budget)'}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
