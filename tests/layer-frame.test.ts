import test from 'node:test';
import assert from 'node:assert/strict';
import { layerFrame, type LayerTokens, type LayerKind, type LayerSize, type LayerSide } from '../ui/components/ui/layerFrame.ts';

const tokens: LayerTokens = { sizes: { s: 400, m: 560, l: 720, xl: 960 }, margin: 16, desktopTop: 48, browserTop: 20 };
const kinds: LayerKind[] = ['panel', 'dialog'];
const sizes: LayerSize[] = ['s', 'm', 'l', 'xl'];
const sides: LayerSide[] = ['left', 'center', 'right'];
const viewports = [
  { width: 390, height: 844, desktop: false },
  { width: 640, height: 800, desktop: true },
  { width: 759, height: 500, desktop: true },
  { width: 760, height: 500, desktop: false },
  { width: 1280, height: 800, desktop: true },
  { width: 1440, height: 900, desktop: false },
];

test('layer frames remain inside viewport margins at every size and slot', () => {
  // Property: Every supported slot and size fits inside the viewport margins at its height cap.
  for (const viewport of viewports) for (const kind of kinds) for (const size of sizes) for (const side of sides) {
    const frame = layerFrame(kind, size, side, viewport, tokens, 4000);
    assert.ok(frame.x >= tokens.margin);
    assert.ok(frame.y >= tokens.margin);
    assert.ok(frame.x + frame.width <= viewport.width - tokens.margin);
    assert.ok(frame.y + frame.height <= viewport.height - tokens.margin);
    assert.ok(frame.width <= viewport.width - tokens.margin * 2);
    assert.equal(frame.height, frame.maxHeight);
  }
});

test('trigger positions affect entry direction while preserving the slot rectangle', () => {
  // Property: The trigger changes only the normalized entry vector and never changes the final frame.
  for (const viewport of viewports) for (const kind of kinds) for (const side of sides) {
    const baseline = layerFrame(kind, 'm', side, viewport, tokens, 240);
    for (const trigger of [{ x: 0, y: 0, width: 32, height: 32 }, { x: 1000, y: 700, width: 40, height: 40 }]) {
      const frame = layerFrame(kind, 'm', side, viewport, tokens, 240, trigger);
      const { entry, ...rect } = frame;
      const { entry: defaultEntry, ...expected } = baseline;
      assert.deepEqual(rect, expected);
      assert.ok(Math.abs(Math.hypot(entry.x, entry.y) - (kind === 'dialog' ? 6 : 8)) < 1e-10);
      const dx = rect.x + rect.width / 2 - trigger.x - trigger.width / 2;
      const dy = rect.y + rect.height / 2 - trigger.y - trigger.height / 2;
      assert.ok(entry.x * dx + entry.y * dy > 0);
      assert.equal(defaultEntry.x, 0);
      assert.ok(defaultEntry.y < 0);
    }
  }
});

test('short content fits and content growth cannot move the top edge', () => {
  // Property: Content height only grows the layer to its cap while preserving its top and width.
  for (const viewport of viewports) for (const kind of kinds) {
    const short = layerFrame(kind, 'l', 'center', viewport, tokens, 120);
    const tall = layerFrame(kind, 'l', 'center', viewport, tokens, 4000);
    assert.equal(short.height, 120);
    assert.equal(short.x, tall.x);
    assert.equal(short.y, tall.y);
    assert.equal(short.width, tall.width);
    assert.ok(short.height <= tall.height);
    assert.equal(short.y, kind === 'dialog' ? Math.max(viewport.desktop ? 48 : 20, viewport.height * 0.12) : viewport.desktop ? 48 : 20);
  }
});

test('portrait and narrow viewports collapse all slots to the available width', () => {
  // Property: Portrait or below-760px viewports give every layer one full-width slot between the side margins.
  for (const viewport of viewports.filter(value => value.width < 760 || value.height > value.width)) {
    for (const kind of kinds) for (const side of sides) for (const size of sizes) {
      const frame = layerFrame(kind, size, side, viewport, tokens, 240);
      assert.equal(frame.x, tokens.margin);
      assert.equal(frame.width, viewport.width - tokens.margin * 2);
    }
  }
});
