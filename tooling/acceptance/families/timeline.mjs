import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const checks = [{ stage: 'beforeNavigate', order: -1, visual: false, async run({ page, name }) {
  if (name !== 'task-timeline-scroll') return;
  await page.addInitScript(() => {
    window.__timelineOpenScroll = new Promise(resolve => {
      const sample = () => {
        const node = document.querySelector('.timeline-scroll');
        if (node && node.scrollHeight > node.clientHeight + 200 && getComputedStyle(node.closest('.layer-panel')).visibility !== 'hidden') {
          resolve({ top: node.scrollTop, gap: node.scrollHeight - node.scrollTop - node.clientHeight });
        } else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
  });
} }, { stage: 'verify', order: 100, visual: false, async run({ page, fixture, name, root, row }) {
  if (name !== 'task-timeline-scroll') return;
  // Regression: opening task details started at the top and measurement repeatedly reset user scrolling.
  const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const timeline = page.getByRole('dialog').getByLabel(messages['timeline.title'], { exact: true });
  const node = await timeline.elementHandle();
  const bottom = () => page.waitForFunction(element => element.scrollHeight > element.clientHeight + 200
    && element.scrollHeight - element.scrollTop - element.clientHeight < 2, node, { timeout: 5000 });
  const opened = await page.evaluate(() => window.__timelineOpenScroll);
  if (opened.gap > 2) throw new Error(`Timeline opened away from the latest entry: ${JSON.stringify(opened)}`);
  await bottom();
  await timeline.focus();
  await timeline.press('Home');
  await page.waitForFunction(element => element.scrollTop < 2, node);
  const append = text => page.evaluate(async text => {
    const { scenarioResponse } = await import('/scenarios.ts');
    scenarioResponse('tasks/control', 'POST', { op: 'codex_send', args: { threadId: 'fixture-task-0', sendMode: 'steer', prompt: text } });
  }, text);
  await append('New update while reading earlier history');
  await page.getByText('New update while reading earlier history', { exact: true }).waitFor({ state: 'attached' });
  if (await timeline.evaluate(element => element.scrollTop) > 2) throw new Error('Appended content moved the historical reading position.');
  await timeline.press('End');
  await bottom();
  await append('New update while following the latest entry');
  await page.getByText('New update while following the latest entry', { exact: true }).waitFor({ state: 'attached' });
  await bottom();
  row.timelineScroll = { openedAtBottom: true, historyPositionHeld: true, followingResumed: true };
} }];
