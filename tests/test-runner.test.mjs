import test from 'node:test';
import assert from 'node:assert/strict';
import { runTestCommand } from '../tooling/test.mjs';

test('daily command deadlines stop a hung process and surface failure', async () => {
  // Regression: lifecycle waits made routine test runs exceed three minutes without a wall-clock budget.
  await assert.rejects(runTestCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), { code: 'TEST_BUDGET_EXCEEDED' });
});
