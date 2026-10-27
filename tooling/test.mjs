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
  await run(process.execPath, ['--test',
    'tests/acceptance-fault.test.ts',
    'tests/accounts.test.ts',
    'tests/activity-ui.test.ts',
    'tests/agent-archive.test.ts',
    'tests/app-env-renderer.test.ts',
    'tests/app-env.test.ts',
    'tests/bubble-read.test.ts',
    'tests/cli-failures.test.ts',
    'tests/cli-readiness.test.ts',
    'tests/control-mcp.test.ts',
    'tests/dev-identity.test.ts',
    'tests/dispatch-policy.test.ts',
    'tests/dispatch-spec.test.ts',
    'tests/dispatch-spec-label.test.ts',
    'tests/dom-assert.test.ts',
    'tests/i18n-message.test.ts',
    'tests/live-ui-projection.test.ts',
    'tests/isolated-selector.test.ts',
    'tests/notification-account.test.ts',
    'tests/panel-state.test.ts',
    'tests/privacy.test.ts',
    'tests/release.test.mjs',
    'tests/request-routing.test.ts',
    'tests/src-conversations.test.ts',
    'tests/src-setup.test.ts',
    'tests/task-agent-paths.test.ts',
    'tests/task-arc-pending.test.ts',
    'tests/task-detail-panel.test.ts',
    'tests/task-list-cost.test.ts',
    'tests/task-locales.test.ts',
    'tests/task-projection.test.ts',
    'tests/task-retry.test.ts',
    'tests/timeline-links.test.ts',
    'tests/timeline-subscription.test.ts',
    'tests/timeline-wheel.test.ts',
    'tests/token-contrast.test.mjs',
    'tests/topology-orientation.test.ts',
    'tests/topology-render.test.ts',
    'tests/topology.test.ts',
    'tests/updates-renderer.test.ts',
    'tests/updates.test.ts',
    'tests/writer-conflict.test.ts',
  ]);
} finally { await run(process.execPath, ['tooling/prune-build-cache.mjs', '--keep=target/debug']); }
await recordTestPass(before);
