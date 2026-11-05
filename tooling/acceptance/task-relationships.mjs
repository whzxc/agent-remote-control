import path from 'node:path';

export async function verifyTaskRelationships(page, fixture, messages, out, key, screenshots) {
  const button = index => page.getByRole('button', { name: new RegExp(`^${fixture.tasks[index].title} ·${fixture.tasks[index].parent !== undefined ? ` ${messages[`activity.relation.${fixture.tasks[index].relationKind ?? 'subagent'}`]} ·` : ''}`) });
  const more = page.getByRole('button', { name: messages['activity.moreChildren'].replace('{count}', '4'), exact: true });
  await more.waitFor();
  await button(1).waitFor();
  await button(8).waitFor();
  const layout = await page.locator('.task-family-wire').evaluateAll(paths => paths.filter(path => path.getBoundingClientRect().height > 1 && path.getBoundingClientRect().width < 1).length);
  if (layout !== 1) throw new Error(`Expected one shared family trunk, found ${layout}`);
  const clipped = await page.locator('.activity-phase .task-relation').evaluateAll(labels => labels.some(label => {
    const text = label.getBoundingClientRect(), bubble = label.closest('.activity-bubble').getBoundingClientRect();
    return text.right > bubble.right || text.left < bubble.left;
  }));
  if (clipped) throw new Error('A task relationship label exceeds its bubble');
  const summaryBox = await more.boundingBox();
  const joined = await page.locator('.task-family-wire').evaluateAll((paths, box) => paths.some(path => {
    const rect = path.getBoundingClientRect();
    return rect.width > 1 && Math.abs(rect.y - box.y - box.height / 2) < 2
      && Math.min(Math.abs(rect.left - box.x - box.width), Math.abs(rect.right - box.x)) < 2;
  }), summaryBox);
  if (!joined) throw new Error('The family overflow control is detached from its shared trunk');
  if (screenshots) await page.screenshot({ path: path.join(out, `${key}-family.png`), animations: 'disabled' });
  await more.press('Enter');
  for (let i = 4; i <= 7; i++) await button(i).waitFor();
  await page.keyboard.press('Escape');
  await more.waitFor();
  await page.waitForFunction(label => document.activeElement?.textContent?.trim() === label, messages['activity.moreChildren'].replace('{count}', '4'));
  for (const index of [1, 2]) {
    if (index === 2) await page.evaluate(async () => {
      const { trackedActivity } = await import('/state/activityBubbles.ts');
      trackedActivity.set(old => ({ ...old, codex: old.codex.filter(row => row.id !== 'fixture-task-0') }));
    });
    await button(index).click();
    const dialog = page.getByRole('dialog', { name: fixture.tasks[index].title, exact: true });
    await dialog.waitFor();
    await dialog.locator('header').getByText(messages[`activity.relation.${fixture.tasks[index].relationKind ?? 'subagent'}`], { exact: true }).waitFor();
    const parent = dialog.getByRole('button', { name: `${messages['activity.parentThread']} ${fixture.tasks[0].title}`, exact: true });
    await parent.waitFor();
    if (screenshots) await page.screenshot({ path: path.join(out, `${key}-detail-${index}.png`), animations: 'disabled' });
    await parent.click();
    await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().panels.agent?.session?.id === 'fixture-task-0');
    await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
}
