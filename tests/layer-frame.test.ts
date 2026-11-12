import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFrame, type LayerTokens, type LayerKind, type LayerSide } from '../ui/components/ui/layerFrame.ts';

const tokens: LayerTokens = { sizes: { m: 560, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
const viewports = [
  { width: 390, height: 844, desktop: false },
  { width: 640, height: 800, desktop: true },
  { width: 1280, height: 800, desktop: true },
  { width: 1440, height: 900, desktop: false },
];
const kinds: LayerKind[] = ['panel', 'dialog'];
const sides: LayerSide[] = ['left', 'center', 'right'];

test('every current height stays within the slot margins and shares the available-area center', () => {
  // Property: Every height is capped to the available interval and has its vertical center at that interval's center.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) for (const contentHeight of [0, 120, 160, 600, 4000]) {
    const frame = layerFrame(kind, side, viewport, tokens, contentHeight);
    const top = viewport.desktop ? tokens.desktopTop : tokens.browserTop;
    assert.ok(frame.x >= tokens.margin && frame.x + frame.width <= viewport.width - tokens.margin);
    assert.ok(frame.y >= top && frame.y + frame.height <= viewport.height - tokens.margin);
    assert.equal(frame.y + frame.height / 2, (top + viewport.height - tokens.margin) / 2);
    assert.equal(frame.height, Math.min(contentHeight, frame.maxHeight));
  }
});

test('growing and shrinking heights move both edges symmetrically', () => {
  // Property: The top and bottom edges move by equal opposite amounts for every change in content height.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const small = layerFrame(kind, side, viewport, tokens, 120);
    const large = layerFrame(kind, side, viewport, tokens, 600);
    assert.equal(small.y - large.y, large.y + large.height - small.y - small.height);
    assert.equal(small.width, large.width);
    assert.equal(large.maxHeight, small.maxHeight);
  }
});

test('measurements are independent of prior openings and focus origins', () => {
  // Property: Recomputing the same slot after unrelated measurements always returns the same geometry without trigger or history input.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const initial = layerFrame(kind, side, viewport, tokens, 240);
    for (const unrelatedHeight of [10, 4000, 160]) {
      layerFrame('panel', 'center', viewport, tokens, unrelatedHeight, true);
      layerFrame('dialog', 'right', viewport, tokens, unrelatedHeight);
      assert.deepEqual(layerFrame(kind, side, viewport, tokens, 240), initial);
    }
    const collapsed = viewport.width < 760 || viewport.height > viewport.width;
    const slotWidth = kind === 'panel' && side === 'center' ? tokens.sizes.xl : tokens.sizes.m;
    assert.equal(initial.width, collapsed ? viewport.width - 2 * tokens.margin : Math.min(slotWidth, viewport.width - 2 * tokens.margin));
  }
});
