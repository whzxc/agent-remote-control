import { requireMainCheckout } from './coding-lane.mjs';
import { randomBytes } from 'node:crypto';
import { developmentConfig, developmentEnvironment, isolatedStatus } from './dev-identity.mjs';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readCore, coreRequest } from './dev-core.mjs';
import { beginLifecycle } from './coordination-report.mjs';

// Always allocate new state: never hand the development supervisor an installed instance.
const [option, value] = process.argv.slice(2);
if (option && (option !== '--directory' || !value || !path.isAbsolute(value) || process.argv.length !== 4)) {
  throw new Error('Usage: npm run dev:isolated [--directory /absolute/existing/evidence]');
}
if (!value) requireMainCheckout();
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop isolation requires macOS or Windows; use ARC_STATE_DIR with headless arc start on Linux.');
const root = fileURLToPath(new URL('../', import.meta.url));
const parent = value ? await realpath(value) : path.join(root, 'tmp');
await mkdir(parent, { recursive: true });
const home = await realpath(await mkdtemp(path.join(parent, 'arc-godev-home-')));
const stateDirectory = developmentEnvironment(home).ARC_STATE_DIR;
const env = { ...process.env, ARC_MYGO_DEV_HOME: home, ARC_STATE_DIR: stateDirectory, ARC_DEV_INSTANCE_ID: randomBytes(6).toString('hex') };
await mkdir(stateDirectory);
await writeFile(path.join(stateDirectory, "acceptance-instance.json"), JSON.stringify({ instanceId: env.ARC_DEV_INSTANCE_ID }));
const identity = developmentConfig(env);
console.log(JSON.stringify({ event: 'isolated-starting', stateDirectory, bundleId: identity.identifier, appName: identity.productName }));
const child = spawn(process.execPath, [path.join(root, 'tooling/desktop-dev.mjs')], { cwd: root, env, stdio: 'inherit' });
let ended = false;
let actualExitCode;
let reported = "";
const done = new Promise(resolve => {
  child.once('error', error => { ended = true; actualExitCode = 1; console.error(error.message); resolve(1); });
  child.once('exit', code => { ended = true; actualExitCode = code ?? 1; resolve(actualExitCode); });
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!ended) child.kill(signal); });
const reportingDirectory = path.join(stateDirectory, 'tooling-observations');
const startReport = await beginLifecycle(reportingDirectory, {
  kind: 'isolated.started', repository: root, instance: env.ARC_DEV_INSTANCE_ID, pid: child.pid,
}, { stateDirectory });
await startReport(Number.isInteger(child.pid) && !ended);
try {
  // The existing development supervisor owns signing, rebuilding and cleanup.
  // Read both Core and Desktop before advertising a usable acceptance endpoint.
  while (!ended) {
    try {
      const endpoint = await readCore(stateDirectory);
      if (endpoint) {
        const desktop = await coreRequest(endpoint, 'app');
        const relative = path.relative(home, desktop.executable || '');
        if (!desktop.executable || relative.startsWith('..') || path.isAbsolute(relative)) {
          child.kill('SIGTERM');
          throw new Error('Isolated Desktop identity is outside its development home.');
        }
        const status=isolatedStatus(identity,endpoint,desktop);
        const signature=JSON.stringify(status);
        if (signature !== reported) {
          console.log(JSON.stringify({event:reported ? 'isolated-restarted' : 'isolated-ready',stateDirectory,...status,
            cli:[process.platform === 'win32' ? path.join(path.dirname(desktop.executable), 'bin/arc.exe') : path.resolve(path.dirname(desktop.executable), '../Resources/bin/arc'),'cli','--state-dir',stateDirectory]}));
          reported=signature;
        }
      }
    } catch (error) {
      if (error.message.startsWith('Isolated Desktop identity')) throw error;
      // Startup can publish Core metadata before Desktop attaches.
    }
    await delay(1000);
  }
  process.exitCode = await done;
} catch (error) {
  console.error(error.message);
  if (!ended) child.kill('SIGTERM');
  await done.catch(() => {});
  process.exitCode = 1;
}
const exitReport = await beginLifecycle(reportingDirectory, {
  kind: 'isolated.exited', repository: root, instance: env.ARC_DEV_INSTANCE_ID, pid: child.pid, exitCode: actualExitCode,
}, { stateDirectory });
await exitReport(ended && Number.isInteger(child.pid));
// State remains available for inspection. No installed state or artifacts are replaced.
