import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const bothThemes = fixture => fixture.homepage?.check === 'task-list';
export const checks = [{ stage: 'verify', order: 19, visual: true, async run({ fixture, page, root, width }) {
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
  const cards = await today.getByRole('article').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  const firstRow = cards.filter(top => top === cards[0]).length;
  if (width < 450 && firstRow !== 1 || width === 820 && firstRow !== 3) throw new Error('Task columns did not adapt to the available width.');
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

async function verifyGroupedTasks(page, fixture) {
  page.setDefaultTimeout(8000);
  const feed = page.getByRole('main', { name: '任务', exact: true });
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
      expected: footer || preview.querySelector('.task-excerpt-retry') ? 3 : 4,
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
