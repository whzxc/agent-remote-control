import { requireMainCheckout } from './coding-lane.mjs';
requireMainCheckout();
import { randomBytes } from 'node:crypto';
import { developmentConfig, isolatedStatus } from './dev-identity.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readCore, coreRequest } from './dev-core.mjs';
import { beginLifecycle } from './coordination-report.mjs';

// Always allocate new state: never hand the development supervisor an installed instance.
if (process.argv.length !== 2) throw new Error('Usage: npm run dev:isolated. A new state directory is allocated automatically.');
if (!['darwin', 'win32'].includes(process.platform)) throw new Error('Desktop isolation requires macOS or Windows; use ARC_STATE_DIR with headless arc start on Linux.');
const root = fileURLToPath(new URL('../', import.meta.url));
const stateDirectory = await realpath(await mkdtemp(path.join(tmpdir(), 'arc-isolated-')));
const env = { ...process.env, ARC_STATE_DIR: stateDirectory, ARC_DEV_INSTANCE_ID: randomBytes(6).toString('hex') };
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
});
await startReport(Number.isInteger(child.pid) && !ended);
try {
  // The existing development supervisor owns signing, rebuilding and cleanup.
  // Read both Core and Desktop before advertising a usable acceptance endpoint.
  while (!ended) {
    try {
      const endpoint = await readCore(stateDirectory);
      if (endpoint) {
        const desktop = await coreRequest(endpoint, 'app');
        const relative = path.relative(path.join(root, 'target'), desktop.executable || '');
        if (!desktop.executable || relative.startsWith('..') || path.isAbsolute(relative)) {
          child.kill('SIGTERM');
          throw new Error('Isolated Desktop identity is outside this checkout target directory.');
        }
        const status=isolatedStatus(identity,endpoint,desktop);
        const signature=JSON.stringify(status);
        if (signature !== reported) {
          console.log(JSON.stringify({event:reported ? 'isolated-restarted' : 'isolated-ready',stateDirectory,...status,
            cli:[path.join(root,'dist/native',process.platform==='win32'?'arc.exe':'arc'),'cli','--state-dir',stateDirectory]}));
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
});
await exitReport(ended && Number.isInteger(child.pid));
// State remains available for inspection. No installed state or artifacts are replaced.
