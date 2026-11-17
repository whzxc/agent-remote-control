import test from 'node:test';
import assert from 'node:assert/strict';
import en from '../ui/locales/en.json' with { type: 'json' };
import zhCN from '../ui/locales/zh-CN.json' with { type: 'json' };
import { dispatchSpecParts, effortPosition, modelLabel, reasoningLevels } from '../ui/components/composites/dispatchSpecLabel.ts';

test('unknown recorded models remain visible with exact identity matching', () => {
  // Recurring bug class: Claude sessions with claude-opus-5-5 displayed only their effort when the catalog lacked that ID.
  const model = 'claude-opus-5-5';
  for (const models of [[], [{ model }], [{ model, displayName: '', name: '' }], [{ model: `${model}-alias`, displayName: 'Another model' }]]) {
    assert.equal(modelLabel(model, models), model);
    assert.equal(dispatchSpecParts({ model, effort: 'high' }, { models }, key => key).model, model);
  }
  assert.equal(modelLabel(model, [{ model, name: 'Native name' }]), 'Native name');
  assert.equal(modelLabel(model, [{ model, name: 'Native name', displayName: 'Native display' }]), 'Native display');
});

test('recorded Fast tiers use the selected locale without requiring a model', () => {
  // Recurring bug class: DispatchSpec dropped the recorded fast and priority service tiers from its label.
  for (const messages of [en, zhCN]) {
    const translate = (key: string) => messages[key as keyof typeof en] ?? key;
    for (const serviceTier of ['fast', 'priority']) {
      for (const summary of [{ serviceTier }, { model: 'recorded-model', effort: 'max', serviceTier }]) {
        assert.equal(dispatchSpecParts(summary, undefined, translate).tier, translate('activity.fast'));
      }
    }
    for (const serviceTier of [undefined, '', 'default']) {
      assert.equal(dispatchSpecParts({ serviceTier }, undefined, translate).tier, undefined);
    }
    assert.equal(dispatchSpecParts({ serviceTier: 'custom-tier' }, undefined, translate).tier, 'custom-tier');
  }
});

test('catalog tier options cannot supply an unrecorded tier', () => {
  // Recurring bug class: historical dispatch labels must not inherit a Fast tier from current model options.
  const catalog = { currentModel: 'recorded-model', models: [{ model: 'recorded-model', displayName: 'Native model' }],
    options: [{ id: 'serviceTier', values: [{ value: 'priority', name: 'Fast' }] }] };
  const summary = { model: catalog.currentModel, effort: 'max' };
  assert.equal(dispatchSpecParts(summary, catalog, key => key).tier, undefined);
  assert.equal(dispatchSpecParts({ ...summary, serviceTier: 'default' }, catalog, key => key).tier, undefined);
});


test('recorded effort survives missing metadata and cannot borrow another model options', () => {
  // Recurring bug class: an unrecognized recorded effort disappeared or used the current model option label.
  const summary = { model: 'historical-model', effort: 'custom-effort' };
  const catalog = { currentModel: 'current-model', options: [{ id: 'effort', values: [{ value: 'custom-effort', name: 'Current choice' }] }] };
  assert.equal(dispatchSpecParts(summary, catalog, key => key).effort, summary.effort);
  assert.equal(effortPosition(reasoningLevels(summary.model, catalog), summary.effort), undefined);
  assert.deepEqual(effortPosition(reasoningLevels(catalog.currentModel, catalog), summary.effort), { count: 1, index: 0 });
});
