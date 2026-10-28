import test from 'node:test';
import assert from 'node:assert/strict';
import en from '../ui/locales/en.json' with { type: 'json' };
import zhCN from '../ui/locales/zh-CN.json' with { type: 'json' };
import { dispatchSpecLabel, modelLabel } from '../ui/components/composites/dispatchSpecLabel.ts';

test('unknown recorded models remain visible with exact identity matching', () => {
  // Regression: Claude sessions with claude-opus-5-5 displayed only their effort when the catalog lacked that ID.
  const model = 'claude-opus-5-5';
  for (const models of [[], [{ model }], [{ model, displayName: '', name: '' }], [{ model: `${model}-alias`, displayName: 'Another model' }]]) {
    assert.equal(modelLabel(model, models), model);
    assert.ok(dispatchSpecLabel({ model, effort: 'high' }, { models }, key => key).includes(model));
  }
  assert.equal(modelLabel(model, [{ model, name: 'Native name' }]), 'Native name');
  assert.equal(modelLabel(model, [{ model, name: 'Native name', displayName: 'Native display' }]), 'Native display');
});

test('recorded Fast tiers use the selected locale without requiring a model', () => {
  // Regression: DispatchSpec dropped the recorded fast and priority service tiers from its label.
  for (const messages of [en, zhCN]) {
    const translate = (key: string) => messages[key as keyof typeof en] ?? key;
    for (const serviceTier of ['fast', 'priority']) {
      for (const summary of [{ serviceTier }, { model: 'recorded-model', effort: 'max', serviceTier }]) {
        assert.ok(dispatchSpecLabel(summary, undefined, translate).includes(translate('activity.fast')));
      }
    }
    for (const serviceTier of [undefined, '', 'default']) {
      assert.equal(dispatchSpecLabel({ serviceTier }, undefined, translate), '');
    }
    assert.equal(dispatchSpecLabel({ serviceTier: 'custom-tier' }, undefined, translate), 'custom-tier');
  }
});

test('catalog tier options cannot supply an unrecorded tier', () => {
  // Regression: historical dispatch labels must not inherit a Fast tier from current model options.
  const catalog = { currentModel: 'recorded-model', models: [{ model: 'recorded-model', displayName: 'Native model' }],
    options: [{ id: 'serviceTier', values: [{ value: 'priority', name: 'Fast' }] }] };
  const summary = { model: catalog.currentModel, effort: 'max' };
  assert.equal(dispatchSpecLabel(summary, catalog, key => key), dispatchSpecLabel({ ...summary, serviceTier: 'default' }, catalog, key => key));
  assert.ok(!dispatchSpecLabel(summary, catalog, key => key).includes('activity.fast'));
});


test('recorded effort survives missing metadata and cannot borrow another model options', () => {
  // Regression: an unrecognized recorded effort disappeared or used the current model option label.
  const summary = { model: 'historical-model', effort: 'custom-effort' };
  const catalog = { currentModel: 'current-model', options: [{ id: 'effort', values: [{ value: 'custom-effort', name: 'Current choice' }] }] };
  assert.ok(dispatchSpecLabel(summary, catalog, key => key).includes(summary.effort));
  assert.ok(!dispatchSpecLabel(summary, catalog, key => key).includes('Current choice'));
});

test('recorded specifications omit providers even when model display names collide', () => {
  // Regression: duplicate model labels appended the provider name to recorded execution specifications.
  const models = ['official', 'hosted'].map(provider => ({ model: JSON.stringify([provider, 'model']), displayName: 'Example model',
    provider: { id: provider, name: `Example provider ${provider}` } }));
  for (const row of models) {
    assert.equal(modelLabel(row.model, models), row.displayName);
    const summary = { model: row.model, effort: 'max', serviceTier: 'priority' };
    assert.equal(dispatchSpecLabel(summary, { models }, key => key), [row.displayName, 'dispatchSpec.effort.max', 'activity.fast'].join(' · '));
    assert.equal(summary.model, row.model);
  }
});

test('upstream provider decorations are removed without parsing opaque model identities', () => {
  // Regression: native catalog display names embedded a provider suffix even after ARC stopped adding its own.
  const model = JSON.stringify(['adapter', 'provider/model']);
  const catalog = { models: [{ model, name: 'Example model · Hosted provider', displayName: 'Example model · Hosted provider',
    provider: { id: 'adapter', name: 'Adapter' } }] };
  assert.equal(modelLabel(model, catalog.models), 'Example model');
  assert.equal(dispatchSpecLabel({ model, effort: 'high' }, catalog, key => key), ['Example model', 'dispatchSpec.effort.high'].join(' · '));
  assert.equal(modelLabel(model), model);
});
