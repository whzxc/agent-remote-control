import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const bothThemes = fixture => fixture.homepage?.check === 'task-list';
export const checks = [{ stage: 'verify', order: 19, visual: true, async run({ fixture, page, root, width }) {
  if (fixture.coldTaskPreviews) {
    const snapshot = page.getByRole('article', { name: 'Load a native task preview', exact: true });
    await snapshot.getByText('Cold preview ready', { exact: true }).waitFor();
    await snapshot.getByText('Inspect the native history', { exact: true }).waitFor();
    await snapshot.getByText(/Ran 40 commands.*Inspect preview step 40/).waitFor();
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
