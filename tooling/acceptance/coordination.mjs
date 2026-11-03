import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyCoordination(page, fixture, messages, out, key, screenshots) {
  const m = key => messages[`center.${key}`];
  const checks = [];
  const snapshot = suffix => screenshots ? page.screenshot({ path: path.join(out, `${key}-${suffix}.png`), animations: 'disabled' }) : undefined;
  const choose = async (label, option) => {
    const radio = page.getByRole('radio', { name: option, exact: true });
    if (await radio.isVisible()) await radio.click();
    else { await page.getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
  };
  const count = async value => page.waitForFunction(value => window.__ARC_VIEW_MODEL__().coordination.attention.count === value, value);
  const back = () => page.getByRole('button', { name: messages.back, exact: true }).click();
  const save = () => page.getByRole('dialog').getByRole('button', { name: messages.save, exact: true }).click();
  if (fixture.coordinationEntry === 'studio') {
    await page.getByRole('button', { name: messages['studio.pending'].replace('{count}', '1'), exact: true }).click();
    await page.getByRole('radio', { name: m('input'), exact: true }).waitFor();
    const inputOnly = await page.evaluate(() => window.__ARC_VIEW_MODEL__().coordination.view.filter);
    assert.equal(inputOnly, 'input');
    checks.push('Studio task-only summary opens pending input');
    await choose(m('filter'), m('all'));
  }
  await page.getByRole('heading', { name: m('title'), exact: true }).waitFor();
  if (fixture.coordination === 'empty') {
    await page.getByText(m('noAttention'), { exact: true }).waitFor();
    await page.getByText(m('emptyEvents'), { exact: true }).waitFor();
    await choose(m('view'), m('board'));
    await page.getByText(m('emptyBoard'), { exact: true }).waitFor();
    return ['genuine empty state'];
  }
  if (fixture.coordination === 'unavailable') {
    await page.getByText(/SCENARIO_BOARD_UNAVAILABLE/).waitFor(); await snapshot('unavailable');
    assert.equal((await page.evaluate(() => window.__ARC_VIEW_MODEL__())).coordination.attention.count, null);
    await page.getByRole('button', { name: messages.retry, exact: true }).click();
    checks.push('unavailable owner never reports zero; retry recovers');
  }
  if (fixture.coordination === 'gap') {
    await page.getByText(/CURSOR_EXPIRED/).waitFor(); await snapshot('gap');
    await page.getByRole('button', { name: m('reset'), exact: true }).click();
    await page.getByText('ARC restarted', { exact: true }).waitFor();
    await page.getByText(new RegExp(m('retainedGap'))).waitFor();
    return ['explicit cursor gap and owner reset'];
  }
  if (fixture.coordination === 'problems') {
    await count(7);
    for (const kind of ['connection','notification','update']) {
      const region = page.getByRole('region', { name: m('attention'), exact: true });
      await region.getByRole('button').filter({ hasText: m(kind) }).click();
      await page.getByRole('dialog').waitFor({ state: 'visible' });
      await page.keyboard.press('Escape');
      await page.getByRole('heading', { name: m('title'), exact: true }).waitFor();
      await count(7);
    }
    return ['current connection, notification and update problems open original controls without resolving them'];
  }
  await count(4);
  if (!['normal','revision'].includes(fixture.coordination)) return checks;
  await choose(m('resourceFilter'), 'Sample project');
  await page.getByRole('button', { name: messages.viewUpdate, exact: true }).waitFor({ state: 'hidden' });
  await choose(m('resourceFilter'), m('allResources'));
  await page.getByText('ARC restarted', { exact: true }).waitFor();
  checks.push('resource scope changes keep independent cursors');
  // Regression: opening a failed historical observation must preserve its turn without resolving current attention.
  const oldEvent = page.getByRole('button', { name: fixture.tasks[1].title, exact: true }).last();
  await oldEvent.click();
  await page.getByRole('dialog', { name: fixture.tasks[1].title, exact: true }).waitFor();
  await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().taskDetail?.timeline);
  const original = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
  assert.equal(original.taskDetail.id, 'fixture-task-1');
  assert.equal(original.taskDetail.turnId, 'fixture-turn-1-1');
  assert.equal(original.taskDetail.state, 'failed');
  await page.keyboard.press('Escape'); await count(4);
  await page.getByRole('heading', { name: m('title'), exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'event-event-2-fixture-task-1');
  checks.push('existing task detail and return preserve history and attention');

  // Regression: task input uses the original responder and removes only its current attention item.
  await choose(m('filter'), m('input'));
  await page.getByRole('region', { name: m('attention'), exact: true }).getByRole('button', { name: new RegExp(`^${fixture.tasks[0].title}`) }).click();
  const task = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
  if (!await page.getByRole('radio', { name: 'Current change', exact: true }).isVisible()) await task.getByRole('button', { name: new RegExp(messages['detail.openRequest']) }).click();
  await page.getByRole('radio', { name: 'Current change', exact: true }).click();
  await page.getByRole('button', { name: messages['detail.sendAnswer'], exact: true }).click();
  await count(3);
  await page.keyboard.press('Escape');
  await page.getByText(m('noAttention'), { exact: true }).waitFor(); await count(3);
  checks.push('original responder refreshes current input attention');
  await choose(m('filter'), m('all'));
  await choose(m('view'), m('board'));
  await snapshot('board');
  await page.getByRole('button', { name: /^Review the shared renderer/ }).click();
  await page.getByRole('button', { name: m('notice_update'), exact: true }).click();
  const changed = 'Updated synthetic coordination notice';
  await page.getByRole('textbox', { name: m('summary'), exact: true }).fill(changed);
  await save();
  if (fixture.coordination === 'revision') {
    await page.getByText(/COORDINATION_REVISION_CONFLICT/).waitFor();
    await page.getByRole('button', { name: m('refreshDraft'), exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: m('summary'), exact: true }).inputValue(), changed);
    await page.getByRole('dialog').getByRole('button', { name: messages.save, exact: true }).waitFor({ state: 'visible' });
    await save();
    checks.push('revision refresh preserves draft');
  }
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: changed, exact: true }).waitFor();
  await page.getByRole('button', { name: m('notice_close'), exact: true }).click(); await save();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByText(m('state.closed'), { exact: true }).waitFor(); await back();
  checks.push('notice update and closure read back through owner');

  await page.getByRole('button', { name: /^Registered build lane/ }).click();
  await page.getByRole('button', { name: m('blocker_clear'), exact: true }).click();
  await save();
  const evidence = page.getByRole('textbox', { name: m('evidence'), exact: true });
  assert.equal(await evidence.getAttribute('aria-invalid'), 'true');
  await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
  assert.equal(await evidence.evaluate(element => element === document.activeElement), true, 'invalid evidence receives focus');
  await evidence.fill('receipt-inspected');
  await page.getByRole('textbox', { name: m('reason'), exact: true }).fill('Non-code recovery observed');
  await save(); await page.getByRole('dialog').waitFor({ state: 'hidden' }); await count(2);
  await page.getByText('receipt-inspected', { exact: true }).waitFor();
  await snapshot('clearance'); await back();
  checks.push('clearance requires evidence and retains recovery data without resuming tasks');

  await page.getByRole('button', { name: m('notice_post'), exact: true }).click();
  await page.getByRole('textbox', { name: m('summary'), exact: true }).fill('New synthetic local scope');
  await page.getByRole('dialog').getByRole('checkbox', { name: 'ARC', exact: true }).check(); await save();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: /^New synthetic local scope/ }).waitFor();
  await page.getByRole('button', { name: m('blocker_open'), exact: true }).click();
  await page.getByRole('textbox', { name: m('summary'), exact: true }).fill('New synthetic resource blocker');
  await page.getByRole('textbox', { name: m('cause'), exact: true }).fill('inspection-required');
  await page.getByRole('dialog').getByRole('checkbox', { name: 'ARC', exact: true }).check(); await save();
  await page.getByRole('dialog').waitFor({ state: 'hidden' }); await count(3);
  checks.push('local notice and blocker creation');
  await page.getByRole('checkbox', { name: m('history'), exact: true }).check();
  await page.getByRole('button', { name: /^Previous maintenance scope/ }).waitFor();
  checks.push('withdrawn and cleared records remain readable in history');
  await snapshot('history');
  // Regression: long owner metadata and nested editors must remain inside narrow fixture viewports.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, 'document fits viewport');
  await page.getByRole('button', { name: m('notice_post'), exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForFunction(label => document.activeElement?.textContent?.trim() === label, m('notice_post'));
  await page.getByRole('button', { name: m('notice_post'), exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: m('notice_post'), exact: true }).evaluate(element => element === document.activeElement), true, 'nested Escape restores editor trigger');
  checks.push('nested Escape restores trigger and retains workspace');
  return checks;
}
