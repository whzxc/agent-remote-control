import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const bothThemes = fixture => ['task-list', 'daily-overflow', 'queue-overflow'].includes(fixture.homepage?.check);
export const checks = [{ stage: 'verify', order: 19, visual: true, async run({ fixture, page, root, width, height }) {
  if (fixture.homepage?.check === 'daily-overflow') {
    await verifyDailyOverflow(page, { width, height });
    return;
  }
  if (fixture.homepage?.check === 'queue-overflow') {
    const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
    await verifyQueueOverflow(page, fixture.tasks, width, messages);
    return;
  }
  if (fixture.homepage?.check === 'grouped') {
    await verifyGroupedTasks(page, fixture);
    return;
  }
  if (fixture.coldTaskPreviews) {
    const snapshot = page.getByRole('article', { name: 'Load a native task preview', exact: true });
    await snapshot.getByText('Cold preview ready', { exact: true }).waitFor();
    await snapshot.getByRole('button', { name: /Open task detail:/ }).click();
    const detail = page.getByRole('dialog', { name: 'Load a native task preview', exact: true });
    await detail.getByText('Inspect the native history', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await detail.waitFor({ state: 'hidden' });
    if (await page.getByRole('dialog').count()) throw new Error('A detail layer was required to load a preview.');
    return;
  }
  if (fixture.homepage?.check !== 'task-list') return;
  const text = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const feed = page.getByRole('main', { name: text['homepage.tasks'], exact: true });
  const today = feed.getByRole('region', { name: text['agentPanel.today'], exact: true });
  const yesterday = feed.getByRole('region', { name: text['agentPanel.yesterday'], exact: true });
  const cards = await today.getByRole('article').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  const firstRow = cards.filter(top => top === cards[0]).length;
  if (width < 450 && firstRow !== 1 || width === 820 && firstRow !== 3) throw new Error('Task columns did not adapt to the available width.');
  await expandDay(today);
  await expandDay(yesterday);
  const name = 'Verify the release checklist';
  const history = yesterday.getByRole('article', { name, exact: true });
  const preview = article => article.getByRole('region', { name: text['homepage.recentSteps'], exact: true });
  const todayCard = today.getByRole('article', { name: 'Summarize the queue', exact: true });
  await preview(todayCard).waitFor();
  await history.getByRole('img', { name: /→ Codex/ }).waitFor();
  // Regression: task cards used the beginning of the workspace path in place of the project name.
  const verifyProject = async (surface, name) => {
    const project = surface.getByRole('img', { name: `${text['project.label']} · ${name} · /workspace/acceptance`, exact: true });
    if ((await project.innerText()).trim() !== name) throw new Error('The project chip shows metadata besides the project name.');
    return project;
  };
  const historyProject = await verifyProject(history, 'Release operations');
  await verifyProject(todayCard, 'Dispatch service');
  // Regression: recorded efforts without usable catalog metadata appeared as text inside the execution spec.
  const specs = [
    [history.getByRole('img', { name: /gpt-6\.1[- ]sol .*high/i }), text['dispatchSpec.effort.high']],
    [todayCard.getByRole('img', { name: /future-model .*custom-effort/ }), 'custom-effort'],
  ];
  for (const [spec, effort] of specs) {
    if ((await spec.innerText()).toLowerCase().includes(effort.toLowerCase())) {
      throw new Error('The recorded effort label is visible in the execution spec.');
    }
  }
  await history.getByText('02:21', { exact: true }).waitFor();
  const turns = text['timeline.turnCount'].replace('{count}', '3');
  await history.getByText(turns, { exact: true }).waitFor();
  if (await preview(history).count()) throw new Error('Historical summary rendered timeline content.');
  await history.evaluate(article => article.scrollIntoView({ block: 'end' }));
  if (width === 1280 && fixture.theme === 'light') {
    await historyProject.hover();
    await page.getByRole('tooltip').filter({ hasText: '/workspace/acceptance' }).waitFor();
  }
  await history.getByRole('button', { name: `${text['homepage.openDetail']}: ${name}`, exact: true }).click();
  const detail = page.getByRole('dialog', { name, exact: true });
  await detail.waitFor();
  await verifyProject(detail, 'Release operations');
  await detail.getByText(turns, { exact: true }).waitFor();
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
} }];

async function expandDay(day) {
  const toggle = day.locator('.homepage-task-overflow[aria-expanded=false]');
  if (await toggle.count()) await toggle.click();
}

async function verifyQueueOverflow(page, tasks, width, messages) {
  const feed = page.getByRole('main', { name: messages['homepage.tasks'], exact: true });
  const today = feed.getByRole('region', { name: messages['agentPanel.today'], exact: true });
  const card = task => today.getByRole('article', { name: task.title, exact: true });
  const completed = tasks.filter(task => task.completed);
  const active = tasks.filter(task => !task.completed);
  const dialog = page.getByRole('dialog');
  const waitForAllCards = async () => {
    for (const task of tasks) await card(task).waitFor();
  };
  assert.equal(await dialog.count(), 0, 'Opening the Tasks feed must leave task details closed.');
  if (width !== 640) {
    await waitForAllCards();
    assert.equal(await today.getByRole('button', { expanded: false }).or(today.getByRole('button', { expanded: true })).count(), 0,
      'Tasks that fit in two rows need no disclosure.');
    return;
  }

  const label = key => messages[`homepage.${key}`].replace('{count}', String(completed.length));
  const expand = today.getByRole('button', { name: label('expandTasks'), expanded: false, exact: true });
  const collapse = today.getByRole('button', { name: label('collapseTasks'), expanded: true, exact: true });
  const isFocused = locator => locator.evaluate(node => node === document.activeElement);
  const verifyCollapsed = async () => {
    await expand.waitFor();
    for (const task of active) await card(task).waitFor();
    for (const task of completed) assert.equal(await card(task).count(), 0, 'Completed cards must stay collapsed behind the stack.');
    assert.equal(await dialog.count(), 0);
  };
  const verifyExpanded = async () => {
    await collapse.waitFor();
    await waitForAllCards();
    assert.equal(await dialog.count(), 0);
  };

  await verifyCollapsed();
  await expand.click();
  await verifyExpanded();
  await collapse.click();
  await verifyCollapsed();
  assert.ok(await isFocused(expand), 'Collapsing must return focus to the stack.');
  await page.keyboard.press('Shift+Tab');
  assert.ok(!await isFocused(expand), 'Shift+Tab must move focus away from the stack.');
  await page.keyboard.press('Tab');
  assert.ok(await isFocused(expand), 'Tab must reach the collapsed stack.');
  await page.keyboard.press('Enter');
  await verifyExpanded();

  const firstRevealed = today.getByRole('article').nth(active.length).getByRole('button', {
    name: `${messages['homepage.openDetail']}: `, exact: false,
  });
  assert.ok(await isFocused(firstRevealed), 'Expansion must focus the first revealed task.');
  const hiddenTask = completed[0];
  const openTask = card(hiddenTask).getByRole('button', {
    name: `${messages['homepage.openDetail']}: ${hiddenTask.title}`, exact: true,
  });
  await openTask.press('Enter');
  const detail = page.getByRole('dialog', { name: hiddenTask.title, exact: true });
  await detail.waitFor();
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
  await verifyExpanded();
  assert.ok(await isFocused(openTask), 'Closing a revealed task must return focus to its card.');
  await collapse.press('Space');
  await verifyCollapsed();
  assert.ok(await isFocused(expand), 'Keyboard collapse must return focus to the stack.');
}

async function verifyDailyOverflow(page, viewport) {
  const feed = page.getByRole('main', { name: '任务', exact: true });
  const today = feed.getByRole('region', { name: '今天', exact: true });
  const yesterday = feed.getByRole('region', { name: '昨天', exact: true });
  const singleColumn = viewport.width === 390;
  const visible = singleColumn ? 1 : 7;
  const label = (action, count) => `${action} ${count} 个任务`;
  const expand = count => yesterday.getByRole('button', { name: label('展开', count), exact: true });
  const count = 11 - visible;
  const toggle = expand(count);
  await toggle.waitFor();
  if (await yesterday.getByRole('article').count() !== visible || await today.getByRole('article').count() !== (singleColumn ? 1 : 4)) {
    throw new Error('Each date must use its own two-row budget.');
  }
  await today.locator('.task-excerpt-lines').first().waitFor();
  if (!await today.locator('.task-card-excerpt').evaluateAll(previews => previews.every(preview => {
    const bounds = preview.getBoundingClientRect();
    const body = preview.querySelector('.task-excerpt-lines')?.getBoundingClientRect();
    return body && [body.top - bounds.top, bounds.bottom - body.bottom, body.left - bounds.left, bounds.right - body.right]
      .every(inset => Math.abs(inset - 12) < 1);
  }))) throw new Error('Preview text must have 12px of padding on every side.');
  if (!await toggle.evaluate(node => {
    const row = node.getBoundingClientRect().top;
    const previousRows = new Set([...node.parentElement.children].map(card => card.getBoundingClientRect().top));
    return node === node.parentElement.lastElementChild && previousRows.size === 2 && row === Math.max(...previousRows)
      && getComputedStyle(node, '::before').content !== 'none' && getComputedStyle(node, '::after').content !== 'none';
  })) throw new Error('The stacked expansion card must end the second row.');

  await toggle.press('Enter');
  const collapse = yesterday.getByRole('button', { name: label('收起', count), exact: true });
  await collapse.waitFor();
  if (await yesterday.getByRole('article').count() !== 11 || await today.getByRole('article').count() !== (singleColumn ? 1 : 4)
    || !await collapse.evaluate(node => node === node.parentElement.lastElementChild && node.previousElementSibling?.matches('article')
      && getComputedStyle(node, '::before').content === 'none' && getComputedStyle(node, '::after').content === 'none')) {
    throw new Error('The single-layer collapse card must follow the last task of the expanded date.');
  }
  const focused = await yesterday.getByRole('article').nth(visible).locator('[data-task-open]').evaluate(node => node === document.activeElement);
  if (!focused) throw new Error('Expansion must focus the first revealed task.');
  if (await yesterday.locator('[data-children]').count() || !await yesterday.getByRole('article').evaluateAll(cards => cards.every(card => card.getBoundingClientRect().height === 106))) {
    throw new Error('Compact task cards must have equal heights and omit subtask counts.');
  }
  await collapse.press('Enter');
  await toggle.waitFor();
  if (!await toggle.evaluate(node => node === document.activeElement)) throw new Error('Collapse must return focus to the stack.');

  if (!singleColumn) {
    await page.setViewportSize({ width: 820, height: viewport.height });
    await expand(6).waitFor();
    await page.setViewportSize({ width: 1600, height: viewport.height });
    await yesterday.locator('.homepage-task-overflow').waitFor({ state: 'detached' });
    if (await yesterday.getByRole('article').count() !== 11) throw new Error('Tasks that fit in two rows need no disclosure.');
    await page.setViewportSize(viewport);
    await toggle.waitFor();
  }
  await feed.evaluate(node => { node.scrollTop = 0; });
}

async function verifyGroupedTasks(page, fixture) {
  page.setDefaultTimeout(8000);
  const feed = page.getByRole('main', { name: '任务', exact: true });
  await expandDay(feed.getByRole('region', { name: '今天', exact: true }));
  const parent = feed.getByRole('article', { name: fixture.tasks[0].title, exact: true });
  const children = parent.getByRole('button', { name: /4 个子任务.*1 个待确认/ });
  await children.waitFor();
  if (await feed.getByRole('article').count() !== 7) throw new Error('Explicit subagents must group and side chats must stay visible.');
  const heights = await feed.getByRole('region', { name: '今天', exact: true }).getByRole('article').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
  if (heights.some(height => height !== 224)) throw new Error('Homepage card heights differ.');
  const previews = await feed.locator('.task-card-excerpt:has(.task-excerpt-lines)').evaluateAll(items => items.map(preview => {
    const footer = preview.nextElementSibling;
    const lines = getComputedStyle(preview.querySelector('.task-excerpt-lines'));
    return {
      padding: getComputedStyle(preview).padding,
      budget: parseFloat(lines.maxHeight) / parseFloat(lines.lineHeight),
      expected: 4 - Number(Boolean(footer)) - Number(Boolean(preview.querySelector('.task-excerpt-retry'))),
      bottomInset: preview.parentElement.getBoundingClientRect().bottom - (footer ?? preview).getBoundingClientRect().bottom,
    };
  }));
  if (previews.some(item => item.padding !== '12px' || item.budget !== item.expected || Math.round(item.bottomInset) !== 9)) throw new Error('Activity lines must fill the card above its footer or bottom inset.');

  const past = feed.getByRole('region', { name: '昨天', exact: true }).getByRole('article');
  if ((await past.boundingBox()).height >= heights[0] || await past.getByRole('region').count()) throw new Error('Earlier dates must use compact metadata cards.');
  if (!await parent.getAttribute('data-aurora') || await parent.getByText('进行中', { exact: true }).count()) throw new Error('Running task must use Aurora.');
  const spec = parent.getByRole('img', { name: /ultrafast/ });
  if (/ultrafast/i.test(await spec.innerText()) || await spec.locator('.dispatch-spec-ultrafast svg').count() !== 2) throw new Error('Ultrafast must display two bolts.');
  const project = parent.locator('.project-label');
  if ((await spec.boundingBox()).height !== (await project.boundingBox()).height) throw new Error('Metadata chips must share a height.');
  const history = feed.getByRole('article', { name: fixture.tasks[1].title, exact: true });
  await history.scrollIntoViewIfNeeded();
  const heading = history.getByRole('heading', { name: '安装和升级均已通过。', exact: true });
  await heading.waitFor();
  const list = history.locator('.task-excerpt-text ul');
  const headingBox = await heading.boundingBox(), listBox = await list.boundingBox();
  if (!listBox || Math.abs(listBox.y - headingBox.y - headingBox.height) > 1) throw new Error('Markdown headings and lists must occupy consecutive preview lines.');
  const failed = feed.getByRole('article', { name: fixture.tasks[4].title, exact: true });
  await failed.scrollIntoViewIfNeeded();
  await failed.getByRole('button', { name: '重试' }).click();
  await failed.getByText(fixture.tasks[4].finalAnswer, { exact: true }).waitFor();
  await children.click();
  const panel = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
  await panel.getByRole('heading', { name: fixture.tasks[0].title, exact: true }).waitFor();
  if (await panel.locator('.dialog-description').count() || await panel.evaluate(el => getComputedStyle(el).backgroundColor) !== 'rgba(0, 0, 0, 0)') throw new Error('Child list must use a transparent panel with a single parent title.');
  const row = panel.getByRole('button', { name: /核对重试上限/ });
  await row.click();
  const detail = page.getByRole('dialog', { name: 'Curie', exact: true });
  await detail.getByRole('button', { name: '返回', exact: true }).click();
  await row.waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  const empty = feed.getByRole('article', { name: fixture.tasks[5].title, exact: true });
  await empty.scrollIntoViewIfNeeded();
  await empty.getByRole('button', { name: '查看任务详情', exact: true }).click();
  const emptyDetail = page.getByRole('dialog', { name: fixture.tasks[5].title, exact: true });
  await emptyDetail.getByRole('button', { name: '重新加载' }).click();
  await emptyDetail.getByText('暂无正文记录').waitFor();
}
