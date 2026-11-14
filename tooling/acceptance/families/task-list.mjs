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
  await preview(today.getByRole('article', { name: 'Summarize the queue', exact: true })).waitFor();
  await history.getByRole('img', { name: /Codex · / }).waitFor();
  await history.getByRole('img', { name: /gpt-6\.1-sol/i }).waitFor();
  await history.getByText('02:21', { exact: true }).waitFor();
  if (await preview(history).count()) throw new Error('Historical summary rendered timeline content.');
  const cards = await today.getByRole('article').evaluateAll(items => items.map(item => item.getBoundingClientRect().top));
  const firstRow = cards.filter(top => top === cards[0]).length;
  if (width < 450 && firstRow !== 1 || width === 820 && firstRow !== 3) throw new Error('Task columns did not adapt to the available width.');
  await history.getByRole('button', { name: `${text['homepage.openDetail']}: ${name}`, exact: true }).click();
  const detail = page.getByRole('dialog', { name, exact: true });
  await detail.waitFor();
  await page.keyboard.press('Escape');
  await detail.waitFor({ state: 'hidden' });
} }];
