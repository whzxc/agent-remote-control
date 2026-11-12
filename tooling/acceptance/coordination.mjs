import assert from 'node:assert/strict';
import path from 'node:path';

export async function verifyCoordination(page, fixture, messages, out, key, screenshots) {
  const m = key => messages[`center.${key}`];
  const checks = [];
  const snapshot = suffix => screenshots ? page.screenshot({ path: path.join(out, `${key}-${suffix}.png`), animations: 'disabled' }) : undefined;
  const board = () => page.getByRole('dialog', { name: m('title'), exact: true });
  const group = label => board().getByRole('radiogroup', { name: label, exact: true });
  const dropdown = label => board().getByRole('combobox', { name: label, exact: true });
  const choose = async (label, option) => {
    await group(label).or(dropdown(label)).waitFor();
    const radio = group(label).getByRole('radio', { name: option, exact: true });
    if (await radio.isVisible()) {
      await radio.click();
      await group(label).getByRole('radio', { name: option, exact: true, checked: true }).waitFor();
    } else {
      await dropdown(label).click();
      await page.getByRole('listbox').getByRole('option', { name: option, exact: true }).click();
      await dropdown(label).getByText(option, { exact: true }).waitFor();
    }
  };
  const chosen = async (label, option) => {
    const radio = group(label).getByRole('radio', { name: option, exact: true });
    if (await radio.isVisible()) return radio.isChecked();
    return (await dropdown(label).innerText()).trim() === option;
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
  if (fixture.coordination.startsWith('ax')) {
    const clipboard = page.context().browser()?.browserType().name() === 'chromium';
    if (clipboard) await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin });
    await choose(m('view'), 'AX');
    if (fixture.coordination === 'ax-unavailable') {
      await board().getByText(/SCENARIO_AX_UNAVAILABLE/).waitFor();
      await snapshot('ax-unavailable');
      await board().getByRole('button', { name: messages.retry, exact: true }).click();
    }
    const openLabel = m('ax.open').replace('{count}', '5'), closedLabel = m('ax.closed').replace('{count}', '12');
    await group(m('ax.filter')).getByRole('radio', { name: openLabel, checked: true, exact: true }).waitFor();
    await board().getByRole('button', { name: '任务已完成，推送回执仍显示中断', exact: true }).waitFor();
    await snapshot('ax-open');
    await choose(m('ax.filter'), closedLabel);
    await board().getByRole('button', { name: '任务回执到达后，公示牌仍保留旧状态', exact: true }).waitFor();
    await snapshot('ax-closed');
    await board().getByRole('button', { name: m('ax.more'), exact: true }).click();
    await board().getByRole('button', { name: 'Archived fixture issue 7', exact: true }).waitFor();
    const search = board().getByRole('searchbox', { name: m('ax.search'), exact: true });
    await search.fill('AX-108');
    const row = board().getByRole('button', { name: '任务回执到达后，公示牌仍保留旧状态', exact: true });
    await board().getByRole('button', { name: 'Archived fixture issue 7', exact: true }).waitFor({ state: 'hidden' });
    await row.click();
    const detail = board().getByRole('region', { name: m('recordDetail'), exact: true });
    await detail.getByRole('heading', { name: '任务回执到达后，公示牌仍保留旧状态', exact: true }).waitFor();
    await detail.getByText('a1b2c3d', { exact: true }).waitFor();
    await detail.getByText('fixture-receipt-07', { exact: true }).waitFor();
    await detail.getByText('fixture-thread-12', { exact: true }).waitFor();
    await snapshot('ax-detail');
    if (clipboard) {
      await detail.getByRole('button', { name: m('ax.copyCommit'), exact: true }).click();
      await detail.getByRole('button', { name: messages.copied, exact: true }).waitFor();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'a1b2c3d');
    }
    await detail.getByText(m('ax.history'), { exact: true }).scrollIntoViewIfNeeded();
    await detail.getByText(new RegExp(m('ax.action.fix'))).scrollIntoViewIfNeeded();
    await snapshot('ax-history');
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'hidden' });
    assert.equal(await search.inputValue(), 'AX-108');
    await page.waitForFunction(() => document.activeElement?.id === 'ax-row-AX-108');
    await search.fill('missing issue');
    await board().getByText(m('emptyBoard'), { exact: true }).waitFor();
    await search.fill('');
    await choose(m('ax.filter'), openLabel);
    await row.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await close();
    return [...checks, 'AX owner pages compose complete counts; status filters, search, pagination, native detail, retry and layered Escape retain list state'];
  }
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
  await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).getByRole('button', { name: messages.back, exact: true }).click(); await board().waitFor();
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
  await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).getByRole('button', { name: messages.back, exact: true }).click(); await board().waitFor(); await count(5);
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
  await page.getByRole('dialog', { name: fixture.tasks[1].title, exact: true }).getByRole('button', { name: messages.back, exact: true }).click(); await board().waitFor(); await count(5);
  await page.waitForFunction(() => document.activeElement?.id === 'event-event-2-fixture-task-1');
  checks.push('resource filters and original historical task detail preserve view and focus');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'document fits viewport');
  await close();
  checks.push('closing Board restores the homepage summary');
  return checks;
}
