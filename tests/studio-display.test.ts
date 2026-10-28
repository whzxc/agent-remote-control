import test from 'node:test';
import assert from 'node:assert/strict';
import { nextClockTick, parseStudioPhase, studioToneAt } from '../ui/display/model.ts';

test('automatic studio lighting follows local morning and evening boundaries', () => {
  // Property: automatic lighting changes only at the local day boundaries, including across dates.
  for (let day = 1; day <= 31; day++) for (let hour = 0; hour < 24; hour++) {
    const at = new Date(2026, 9, day, hour, 30).getTime();
    assert.equal(studioToneAt(at, 'auto'), hour >= 7 && hour < 19 ? 'day' : 'night');
  }
});

test('explicit studio lighting remains independent of time', () => {
  // Property: each explicit lighting selection is stable across every local hour.
  for (const phase of ['day', 'night'] as const) for (let hour = 0; hour < 24; hour++) {
    assert.equal(studioToneAt(new Date(2026, 9, 29, hour).getTime(), phase), phase);
  }
  assert.equal(parseStudioPhase('unknown'), 'auto');
});

test('clock refresh always reaches the next minute without a busy loop', () => {
  // Property: each clock deadline is positive, within one minute, and aligned to a minute boundary.
  for (const time of [-60_001, -1, 0, 1, 59_999, 60_000, 123_456_789]) {
    const delay = nextClockTick(time);
    assert.ok(delay > 0 && delay <= 60_000);
    assert.equal(Math.abs((time + delay) % 60_000), 0);
  }
});
