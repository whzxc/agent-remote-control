import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOrientation, type Orientation } from '../ui/topology/orientation.ts';

test('orientation retains state inside the hysteresis band', () => {
  // Property: threshold crossings are inclusive and intermediate aspect ratios retain the previous orientation.
  for (const mode of ['portrait', 'landscape'] as Orientation[]) {
    assert.equal(resolveOrientation(mode, 'auto', 850, 1000), 'portrait');
    assert.equal(resolveOrientation(mode, 'auto', 1000, 1000), 'landscape');
    for (const ratio of [0.851, 0.9, 0.999]) assert.equal(resolveOrientation(mode, 'auto', ratio * 1000, 1000), mode);
    assert.equal(resolveOrientation(mode, 'auto', 0, 0), mode);
  }
});
test('drag ownership takes precedence over automatic and manual orientation', () => {
  // Property: no orientation request moves slots while a pointer drag owns them.
  for (const mode of ['portrait', 'landscape'] as Orientation[]) {
    for (const requested of ['auto', 'portrait', 'landscape'] as const) {
      for (const width of [400, 1800]) assert.equal(resolveOrientation(mode, requested, width, 1000, true), mode);
    }
    assert.equal(resolveOrientation(mode, 'portrait', 1800, 900), 'portrait');
    assert.equal(resolveOrientation(mode, 'landscape', 400, 900), 'landscape');
  }
});
