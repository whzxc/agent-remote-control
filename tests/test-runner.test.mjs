import test from 'node:test';
import assert from 'node:assert/strict';
import { runTestCommand } from '../tooling/test.mjs';

test('daily command deadlines stop a hung process and surface failure', async () => {
  // Recurring bug class: lifecycle: test runner enforces the daily wall-clock budget
  await assert.rejects(runTestCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }), { code: 'TEST_BUDGET_EXCEEDED' });
});
