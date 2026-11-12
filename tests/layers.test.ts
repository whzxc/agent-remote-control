import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerStore } from '../ui/state/layers.ts';

test('a third dialog request reports the stack limit instead of disappearing', () => {
  // Regression: B1 silently ignored a third dialog request and left its trigger without a response.
  const store = createLayerStore();
  const request = (id: string) => ({ id, kind: 'dialog' as const, node: null, trigger: null, onClose() {} });
  store.open(request('parent'));
  store.open(request('child'));
  assert.throws(() => store.canOpen('dialog', 'third'), /at most two dialogs/);
  assert.throws(() => store.open(request('third')), /at most two dialogs/);
  assert.deepEqual(store.get().map(layer => layer.id), ['parent', 'child']);
});
