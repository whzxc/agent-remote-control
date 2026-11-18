export async function verifyTaskRelationships(page, fixture, messages) {
  const feed = page.getByRole('main', { name: messages['homepage.tasks'], exact: true });
  const topLevel = fixture.tasks.filter(task => task.parent === undefined || task.relationKind === 'side-chat');
  for (const task of topLevel) await feed.getByRole('article', { name: task.title, exact: true }).waitFor();
  if (await feed.getByRole('article').count() !== topLevel.length) throw new Error('Subagents must group under their parent card.');
  const subagentCount = fixture.tasks.filter(task => task.parent === 0 && (task.relationKind ?? 'subagent') === 'subagent').length;
  for (const index of [1, 2]) {
    const task = fixture.tasks[index];
    if ((task.relationKind ?? 'subagent') === 'subagent') {
      await feed.getByRole('article', { name: fixture.tasks[0].title, exact: true })
        .getByRole('button', { name: new RegExp(messages['homepage.childCount'].replace('{count}', String(subagentCount))) }).click();
      await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true })
        .getByRole('button', { name: new RegExp(task.title) }).click();
    } else {
      await feed.getByRole('article', { name: task.title, exact: true }).getByRole('button', {
        name: `${messages['homepage.openDetail']}: ${task.title}`, exact: true,
      }).click();
    }
    const dialog = page.getByRole('dialog', { name: task.title, exact: true });
    await dialog.waitFor();
    await dialog.getByText(messages[`activity.relation.${task.relationKind ?? 'subagent'}`], { exact: true }).first().waitFor();
    await dialog.getByRole('button', { name: `${messages['homepage.openDetail']}: ${fixture.tasks[0].title}`, exact: true }).click();
    await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
}
