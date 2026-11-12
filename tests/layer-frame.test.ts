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

test('width and horizontal alignment depend only on the physical slot', () => {
  // Property: Collapsed and expanded slots fill the available width while fixed slots retain their width and mirror alignment.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const small = layerFrame(kind, side, viewport, tokens, 120);
    const large = layerFrame(kind, side, viewport, tokens, 600);
    const collapsed = viewport.width < 760 || viewport.height > viewport.width;
    const width = kind === 'panel' && side === 'center' ? tokens.sizes.xl : tokens.sizes.m;
    assert.equal(small.width, collapsed ? viewport.width - 2 * tokens.margin : Math.min(width, viewport.width - 2 * tokens.margin));
    assert.equal(large.width, small.width);
    const expanded = layerFrame(kind, side, viewport, tokens, 600, true);
    assert.equal(expanded.width, viewport.width - 2 * tokens.margin);
    const opposite = layerFrame(kind, side === 'left' ? 'right' : side === 'right' ? 'left' : 'center', viewport, tokens, 120);
    assert.equal(small.x, viewport.width - opposite.x - opposite.width);
  }
});
