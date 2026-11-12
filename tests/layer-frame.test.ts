import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFrame, type LayerTokens, type LayerKind, type LayerSide } from '../ui/components/ui/layerFrame.ts';
const tokens: LayerTokens = { sizes: { m: 560, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
const viewports = [{ width: 390, height: 844, desktop: false }, { width: 640, height: 800, desktop: true }, { width: 1280, height: 800, desktop: true }, { width: 1440, height: 900, desktop: false }];
const kinds: LayerKind[] = ['panel', 'dialog'], sides: LayerSide[] = ['left', 'center', 'right'];
test('slot frames stay inside the viewport and center their initial content', () => {
  // Property: Initial frames fit the viewport margins and center in the available vertical interval.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) for (const content of [120, 4000]) {
    const f = layerFrame(kind, side, viewport, tokens, content), top = viewport.desktop ? tokens.desktopTop : tokens.browserTop;
    assert.ok(f.x >= tokens.margin && f.x + f.width <= viewport.width - tokens.margin);
    assert.ok(f.y >= top && f.y + f.height <= viewport.height - tokens.margin);
    assert.equal(f.y - top, viewport.height - tokens.margin - f.y - f.height);
  }
});
test('growth preserves the top until the bottom margin requires an upward correction', () => {
  // Property: Growing and shrinking content never moves the top down; growth within bounds preserves it exactly.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const initial = layerFrame(kind, side, viewport, tokens, 120);
    const growing = layerFrame(kind, side, viewport, tokens, 160, undefined, false, initial.y);
    assert.equal(growing.y, initial.y);
    const capped = layerFrame(kind, side, viewport, tokens, 4000, undefined, false, growing.y);
    assert.ok(capped.y <= growing.y && capped.y + capped.height <= viewport.height - tokens.margin);
    const shrinking = layerFrame(kind, side, viewport, tokens, 100, undefined, false, capped.y);
    assert.equal(shrinking.y, capped.y);
  }
});
test('width depends on the slot and never on content or trigger coordinates', () => {
  // Property: Only the physical slot and explicit expansion determine width; triggers affect entry direction alone.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const a = layerFrame(kind, side, viewport, tokens, 120), b = layerFrame(kind, side, viewport, tokens, 120, { x: 10, y: 700, width: 40, height: 40 });
    const { entry: _, ...rect } = a, { entry, ...other } = b;
    assert.deepEqual(other, rect);
    assert.ok(Math.hypot(entry.x, entry.y) > 0);
    const collapsed = viewport.width < 760 || viewport.height > viewport.width;
    assert.equal(a.width, collapsed ? viewport.width - tokens.margin * 2 : Math.min(kind === 'panel' && side === 'center' ? tokens.sizes.xl : tokens.sizes.m, viewport.width - tokens.margin * 2));
    assert.equal(a.width, layerFrame(kind, side, viewport, tokens, 4000).width);
  }
});
