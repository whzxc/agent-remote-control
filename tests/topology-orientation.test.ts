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
test('manual orientation takes precedence over aspect ratio', () => {
  // Property: explicit orientation choices ignore viewport aspect ratio.
  for (const current of ['portrait', 'landscape'] as Orientation[]) for (const width of [320, 1800]) {
    assert.equal(resolveOrientation(current, 'portrait', width, 900), 'portrait');
    assert.equal(resolveOrientation(current, 'landscape', width, 900), 'landscape');
  }
});
