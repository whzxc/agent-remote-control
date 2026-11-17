import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Recurring bug class: per-turn repository instructions grew to 17,077 characters.
test('AGENTS.md stays within its 12,000-character budget', () => {
  const characters = [...readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')].length;
  assert.ok(characters <= 12_000,
    `AGENTS.md has ${characters} characters (limit: 12,000). Replace or move existing text instead of appending; link to the owning documentation or check.`);
});
