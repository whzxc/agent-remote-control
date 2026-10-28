import { spawn } from 'node:child_process';
import { enterHeavyBuild } from './heavy-build.mjs';
import { testInputs, recordTestPass, testEnvironment } from './test-cache.mjs';
enterHeavyBuild();
const before = await testInputs();
const env = testEnvironment();
const run = (file, args) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('close', code => code === 0 ? resolve() : reject(new Error(`${file} exited ${code}`)));
});
try {
  await run(process.execPath, ['tooling/prune-build-cache.mjs']);
  await run('cargo', ['test', '--locked', '--manifest-path', 'native/Cargo.toml', '--lib']);
  if (process.platform === 'darwin') await run('cargo', ['test', '--locked', '-p', 'agent-remote-control', '--bin', 'agent-remote-control-desktop', 'src_conversations']);
  await run(process.execPath, ['--test', 'tests/control-mcp.test.ts', 'tests/cli-failures.test.ts', 'tests/agent-archive.test.ts', 'tests/dispatch-policy.test.ts', 'tests/src-conversations.test.ts', 'tests/notification-account.test.ts', 'tests/app-env.test.ts', 'tests/app-env-renderer.test.ts', 'tests/activity-ui.test.ts', 'tests/dispatch-spec-label.test.ts', 'tests/i18n-message.test.ts', 'tests/ui-state-stability.test.ts', 'tests/accounts-ui.test.ts', 'tests/topology-accounts.test.ts', 'tests/task-projection.test.ts', 'tests/timeline-wheel.test.ts', 'tests/topology.test.ts', 'tests/subscription-display.test.ts',
    'tests/topology-render.test.ts', 'tests/topology-orientation.test.ts', 'tests/topology-portrait.test.ts', 'tests/topology-orientation-renderer.test.ts', 'tests/dom-assert.test.ts', 'tests/updates.test.ts', 'tests/updates-renderer.test.ts', 'tests/release.test.mjs', 'tests/coordination-report.test.mjs']);
} finally { await run(process.execPath, ['tooling/prune-build-cache.mjs', '--keep=target/debug']); }
await recordTestPass(before);
