export async function verifyTaskRelationships(page, fixture, messages) {
  const feed = page.getByRole('main', { name: messages['homepage.tasks'], exact: true });
  for (const task of fixture.tasks) await feed.getByRole('article', { name: task.title, exact: true }).waitFor();
  for (const index of [1, 2]) {
    const task = fixture.tasks[index];
    await feed.getByRole('article', { name: task.title, exact: true }).getByRole('button', {
      name: `${messages['homepage.openDetail']}: ${task.title}`, exact: true,
    }).click();
    const dialog = page.getByRole('dialog', { name: task.title, exact: true });
    await dialog.waitFor();
    await dialog.getByText(messages[`activity.relation.${task.relationKind ?? 'subagent'}`], { exact: true }).first().waitFor();
    await dialog.getByRole('button', { name: `${messages['activity.parentThread']} ${fixture.tasks[0].title}`, exact: true }).click();
    await page.getByRole('dialog', { name: fixture.tasks[0].title, exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
}
