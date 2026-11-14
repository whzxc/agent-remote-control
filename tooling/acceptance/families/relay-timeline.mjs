import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const checks = [{ stage: "verify", order: 106, visual: true, async run({ page, name }) {
  if (name !== "relay-done") return;
  const neutral = await page.locator(".task-final").evaluateAll(cards => cards.length > 0 && cards.every(card => {
    const style = getComputedStyle(card);
    return style.borderLeftWidth === style.borderRightWidth && style.borderLeftColor === style.borderRightColor;
  }));
  if (!neutral) throw new Error("Reply or review cards retained a colored left edge.");
} }, { stage: 'verify', order: 105, visual: false, async run({ page, fixture, name, root, row }) {
  if (!name.startsWith('relay-') || !['running', 'needs-you', 'done', 'failed'].some(state => name === `relay-${state}`)) return;
  // Regression: task detail hid reasoning and answering parties, and mixed live plans into settled work.
  const text = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const panel = page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true });
  const back = panel.getByRole('button', { name: text.back, exact: true });
  const sourceMark = back.getByRole('img', { name: 'Claude', exact: true });
  const [headerBounds, markBounds] = await Promise.all([back.boundingBox(), sourceMark.boundingBox()]);
  if (!headerBounds || !markBounds || markBounds.y < headerBounds.y || markBounds.y + markBounds.height > headerBounds.y + headerBounds.height)
    throw new Error('The route source mark escaped its header.');
  const plan = panel.getByRole('button', { name: new RegExp(text['timeline.plan']) });
  const earlier = panel.getByRole('button', { name: new RegExp(`^${text['relay.turn'].replace('{count}', '1')}`) });
  if (await earlier.getAttribute('aria-expanded') !== 'false') throw new Error('Earlier turn must start folded.');
  if (name === 'relay-done') {
    if (await plan.count()) throw new Error('Settled plan remains in the footer.');
    await panel.getByRole('button', { name: text['detail.copyReply'], exact: true }).waitFor();
    const work = panel.getByRole('button', { name: new RegExp(`^${text['detail.workedFor'].split('{')[0]}`) });
    if (await work.getAttribute('aria-expanded') !== 'false') throw new Error('Settled work must start folded.');
    await work.click();
  } else if (name === 'relay-failed') {
    if (await plan.count()) throw new Error('Failed plan remains in the footer.');
    await panel.getByText('Type error: expected a string.', { exact: true }).waitFor();
    if (await panel.getByText('The sample verification command failed.', { exact: true }).count() !== 1)
      throw new Error('The terminal failure must appear only in the failure card.');
    await panel.getByRole('button', { name: text['detail.retry'], exact: true }).waitFor();
  } else {
    await plan.click();
    if (await plan.getAttribute('aria-expanded') !== 'true') throw new Error('Live plan did not expand.');
    await plan.click();
  }
  const thought = panel.getByRole('button', { name: new RegExp(`^${text['relay.thought']}`) }).first();
  if (await thought.getAttribute('aria-expanded') !== 'false') throw new Error('Reasoning must start collapsed.');
  await thought.click();
  if (await thought.getAttribute('aria-expanded') !== 'true') throw new Error('Reasoning did not expand.');
  await thought.click();
  await panel.getByText(text['relay.approvedBy'].replace('{source}', 'Claude'), { exact: true }).waitFor();
  if (name === 'relay-needs-you') {
    const entry = panel.getByRole('button', { name: text['detail.openRequest'], exact: true });
    if (await entry.count()) await entry.click();
    const approve = page.getByRole('button', { name: text['detail.approve'], exact: true });
    await approve.click();
    await panel.getByText(text['relay.approvedBy'].replace('{source}', 'ARC'), { exact: true }).waitFor();
  }
  for (const mark of await panel.getByRole('img', { name: 'Claude', exact: true }).all()) {
    const bounds = await mark.boundingBox();
    const panelBounds = await panel.boundingBox();
    if (bounds && panelBounds && bounds.x + bounds.width > panelBounds.x + panelBounds.width - 20)
      throw new Error('A timeline source mark escaped to the panel edge.');
  }
  row.relayTimeline = { reasoningDisclosure: true, earlierTurnFold: true, answerOrigin: true, planLifecycle: true };
} }];
