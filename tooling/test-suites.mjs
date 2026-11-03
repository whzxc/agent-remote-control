import { readdir } from 'node:fs/promises';

// Native process fixtures and lifecycle waits run only on explicit request.
const integration = new Set([
  'acceptance-fault.test.ts', 'accounts.test.ts', 'agent-archive.test.ts',
  'app-replace.test.ts', 'cli-failures.test.ts', 'cli-readiness.test.ts',
  'coordination-center-native.test.ts', 'control-mcp.test.ts', 'coordination-recovery.test.ts', 'desktop-dispatch.test.ts',
  'dispatch-policy.test.ts', 'notification-account.test.ts', 'panel-state.test.ts',
  'src-conversations.test.ts', 'task-list-cost.test.ts', 'timeline-subscription.test.ts',
  'writer-conflict.test.ts',
]);

// Browser layout fixtures belong to the acceptance entry point.
const browser = new Set(['task-dock-layout.test.ts']);

export async function testFiles(extended = false) {
  return (await readdir(new URL('../tests/', import.meta.url), { recursive: true }))
    .filter(name => /\.test\.[cm]?[jt]sx?$/.test(name) && !browser.has(name) && (extended || !integration.has(name)))
    .sort().map(name => `tests/${name}`);
}
