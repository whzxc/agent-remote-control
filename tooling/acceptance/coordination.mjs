import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyCoordination(page, fixture, messages, out, key, screenshots) {
  const m = key => messages[`center.${key}`];
  const checks = [];
  const snapshot = suffix => screenshots ? page.screenshot({ path: path.join(out, `${key}-${suffix}.png`), animations: 'disabled' }) : undefined;
  const board = () => page.getByRole('dialog', { name: m('title'), exact: true });
  const choose = async (label, option) => {
    const radio = board().getByRole('radio', { name: option, exact: true });
    if (await radio.isVisible()) await radio.click();
    else { await board().getByRole('combobox', { name: label, exact: true }).click(); await page.getByRole('option', { name: option, exact: true }).click(); }
  };
  const chosen = async (label, option) => {
    const radio = board().getByRole('radio', { name: option, exact: true });
    if (await radio.isVisible()) return radio.isChecked();
    return (await board().getByRole('combobox', { name: label, exact: true }).innerText()).trim() === option;
  };
  const count = async value => page.waitForFunction(value => window.__ARC_VIEW_MODEL__().coordination.attention.count === value, value);
  const close = async () => {
    await page.keyboard.press('Escape');
    await board().waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.activeElement?.id === 'board-trigger');
  };
  const open = async () => {
    await page.getByRole('button', { name: m('open'), exact: true }).click();
    await board().waitFor();
    assert.equal(await chosen(m('view'), m('current')), true);
  };
  // Regression: the whole homepage activity summary opens a read-only Board without a capsule entry.
  assert.equal(await page.getByRole('navigation').getByRole('button', { name: m('title'), exact: true }).count(), 0);
  await snapshot('home');
  await open();
  assert.equal(await board().getByRole('textbox').count(), 0);
  checks.push('homepage summary opens Current; Board exposes observation and owner navigation');
  if (fixture.coordination === 'empty') {
    await board().getByText(m('emptyBoard'), { exact: true }).waitFor();
    await snapshot('empty');
    await choose(m('view'), m('activityView'));
    await board().getByText(m('emptyEvents'), { exact: true }).waitFor();
    await count(0); await close();
    return [...checks, 'genuine empty data and keyboard return with Studio disabled'];
  }
  if (fixture.coordination === 'unavailable') {
    await board().getByText(/SCENARIO_BOARD_UNAVAILABLE/).waitFor(); await snapshot('unavailable');
    assert.equal((await page.evaluate(() => window.__ARC_VIEW_MODEL__())).coordination.attention.count, null);
    await board().getByRole('button', { name: messages.retry, exact: true }).click();
    checks.push('unavailable observation retains unknown coverage; refresh recovers');
  }
  await count(fixture.coordination === 'problems' ? 8 : 5);
  // AX candidates are owner-referenced observations: readable, never a desktop action.
  const ax = board().getByRole('region', { name: m('attention'), exact: true }).getByText('Task detail reopens the previous turn after resume');
  assert.equal(await ax.count(), 1);
  assert.equal(await board().getByRole('button', { name: /Task detail reopens the previous turn/ }).count(), 0);
  if (fixture.coordination === 'gap') {
    await choose(m('view'), m('activityView'));
    await board().getByText(/CURSOR_EXPIRED/).waitFor(); await snapshot('gap');
    await board().getByRole('button', { name: m('reset'), exact: true }).click();
    await board().getByText('ARC restarted', { exact: true }).waitFor();
    await board().getByText(new RegExp(m('retainedGap'))).waitFor();
    await close();
    return [...checks, 'explicit retained-history gap and cursor reset'];
  }
  if (fixture.coordination === 'problems') {
    for (const kind of ['connection', 'notification', 'update']) {
      const attention = board().getByRole('region', { name: m('attention'), exact: true });
      const link = attention.getByRole('button', { name: new RegExp(`${m(kind)}$`) });
      const ownerName = kind === 'update' ? messages.appUpdates : (await link.innerText()).slice(0, -m(kind).length).trim();
      await link.click();
      await board().waitFor({ state: 'hidden' });
      const owner = page.getByRole('dialog', { name: ownerName, exact: true });
      await owner.waitFor();
      // Wait for the owner's own focus handoff before sending Escape.
      await page.waitForFunction(node => node.contains(document.activeElement), await owner.elementHandle());
      await owner.press('Escape');
      await owner.waitFor({ state: 'hidden' });
      await board().waitFor(); await count(8);
    }
    await snapshot('problems'); await close();
    return [...checks, 'connection, notification and update links use their owners and preserve outstanding state'];
  }
  await board().getByRole('button', { name: /^Review the shared renderer/ }).waitFor();
  await snapshot('current');
  await board().getByRole('button', { name: /^Review the shared renderer/ }).click();
  await board().getByRole('heading', { name: 'Review the shared renderer and registered worktree', exact: true }).waitFor();
  await snapshot('detail');
  await board().getByRole('region', { name: m('recordDetail'), exact: true }).getByRole('button', { name: fixture.tasks[0].title, exact: true }).click();
  await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).waitFor();
  await page.keyboard.press('Escape'); await board().waitFor();
  await page.waitForFunction(() => document.activeElement?.id === 'link-notice-a-fixture-task-0');
  await page.keyboard.press('Escape');
  assert.equal(await board().isVisible(), true);
  await page.waitForFunction(() => document.activeElement?.id === 'record-notice-a');
  checks.push('record inspection is read-only; layered Escape restores its row');
  await choose(m('filter'), m('history'));
  await board().getByRole('button', { name: /^Previous maintenance scope/ }).waitFor();
  await count(5);
  await choose(m('filter'), m('input'));
  await board().getByRole('region', { name: m('attention'), exact: true }).getByRole('button', { name: new RegExp(`^${fixture.tasks[0].title}`) }).click();
  await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).waitFor();
  await page.keyboard.press('Escape'); await board().waitFor(); await count(5);
  assert.equal(await chosen(m('filter'), m('input')), true);
  checks.push('pending input stays with the task owner; return preserves scope');
  await choose(m('filter'), m('all'));
  await choose(m('view'), m('activityView'));
  await board().getByText('ARC restarted', { exact: true }).waitFor();
  await choose(m('resourceFilter'), 'Sample project');
  await board().getByText('ARC restarted', { exact: true }).waitFor({ state: 'hidden' });
  await choose(m('resourceFilter'), m('allResources'));
  await board().getByText('ARC restarted', { exact: true }).waitFor();
  await snapshot('activity');
  // Regression: a failed historical turn must retain its identity while current attention stays unchanged.
  await board().getByRole('button', { name: fixture.tasks[1].title, exact: true }).last().click();
  await page.getByRole('dialog', { name: fixture.tasks[1].title, exact: true }).waitFor();
  await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().taskDetail?.timeline);
  const original = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
  assert.equal(original.taskDetail.id, 'fixture-task-1');
  assert.equal(original.taskDetail.turnId, 'fixture-turn-1-1');
  assert.equal(original.taskDetail.state, 'failed');
  await page.keyboard.press('Escape'); await board().waitFor(); await count(5);
  await page.waitForFunction(() => document.activeElement?.id === 'event-event-2-fixture-task-1');
  checks.push('resource filters and original historical task detail preserve view and focus');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'document fits viewport');
  await close();
  checks.push('closing Board restores the homepage summary');
  return checks;
}
