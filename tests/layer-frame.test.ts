import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFrame, type LayerTokens, type LayerSize } from '../ui/components/ui/layerFrame.ts';

const tokens: LayerTokens = { sizes: { m: 560, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
const viewports = [
  { width: 390, height: 844, desktop: false },
  { width: 640, height: 800, desktop: true },
  { width: 1280, height: 800, desktop: true },
  { width: 1440, height: 900, desktop: false },
];
const sizes: LayerSize[] = ['m', 'xl'];
test('every current height stays within the slot margins and shares the available-area center', () => {
  // Property: Every height is capped to the available interval and has its vertical center at that interval's center.
  for (const viewport of viewports) for (const size of sizes) for (const contentHeight of [0, 120, 160, 600, 4000]) {
    const frame = layerFrame(size, viewport, tokens, contentHeight);
    const top = viewport.desktop ? tokens.desktopTop : tokens.browserTop;
    assert.ok(frame.x >= tokens.margin && frame.x + frame.width <= viewport.width - tokens.margin);
    assert.ok(frame.y >= top && frame.y + frame.height <= viewport.height - tokens.margin);
    assert.equal(frame.y + frame.height / 2, (top + viewport.height - tokens.margin) / 2);
    assert.equal(frame.height, Math.min(contentHeight, frame.maxHeight));
  }
});

test('every content size shares the centered slot', () => {
  // Property: Content sizes retain their capped width while every layer remains horizontally centered.
  for (const viewport of viewports) for (const size of sizes) {
    const small = layerFrame(size, viewport, tokens, 120);
    const large = layerFrame(size, viewport, tokens, 600);
    const collapsed = viewport.width < 760 || viewport.height > viewport.width;
    const width = tokens.sizes[size];
    assert.equal(small.width, collapsed ? viewport.width - 2 * tokens.margin : Math.min(width, viewport.width - 2 * tokens.margin));
    assert.equal(large.width, small.width);
    const expanded = layerFrame(size, viewport, tokens, 600, true);
    assert.equal(expanded.width, viewport.width - 2 * tokens.margin);
    assert.equal(small.x + small.width / 2, viewport.width / 2);
    assert.equal(expanded.x + expanded.width / 2, viewport.width / 2);
  }
});
