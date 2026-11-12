/** Browser-only checks for workspace placement, retained height and outside-click consumption. */
export async function verifyWorkspace(page, fixture, messages, width, height) {
  const panel = page.locator('.layer-panel');
  if (!await panel.count()) return;
  await panel.waitFor();
  const box = await panel.boundingBox();
  const top = await page.evaluate(() => '__TAURI_INTERNALS__' in window ? 48 : 20);
  const size = fixture.page === 'mcp-hub' || fixture.coordination ? 960 : 720;
  const expectedWidth = width < 760 || height > width ? width - 32 : Math.min(size, width - 32);
  if (!box || Math.abs(box.x - (width - expectedWidth) / 2) > 1 || Math.abs(box.y - top) > 1
    || Math.abs(box.width - expectedWidth) > 1 || box.y + box.height > height - 15) {
    throw new Error(`Workspace must use its center slot: expected ${expectedWidth}px wide at y=${top}, got ${JSON.stringify(box)}.`);
  }
  if (fixture.page === 'settings' && !fixture.settingsExperimental && Math.abs(box.y + box.height - (height - 16)) > 1) {
    throw new Error('Full Settings must reach its height cap.');
  }
  if (fixture.page === 'relay-hosting' && box.y + box.height >= height - 17) {
    throw new Error('Empty Relay hosting must fit its content.');
  }
  if (fixture.mcpHub === 'ready') {
    const search = panel.getByRole('searchbox');
    await search.fill('fixture-no-matching-server');
    const empty = panel.getByRole('status').filter({ hasText: messages['mcp.noMatch'] });
    await empty.waitFor();
    await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame); });
    const filtered = await panel.boundingBox();
    if (!filtered || Math.abs(filtered.y + filtered.height - box.y - box.height) > 1) throw new Error('Filtering shortened the workspace and moved its bottom edge.');
    await search.fill('');
    await empty.waitFor({ state: 'hidden' });
  }
  if (fixture.page === 'settings' && !fixture.settingsExperimental || fixture.page === 'relay-hosting') {
    // A fixture-only native target in the viewport margin makes click consumption observable.
    await page.evaluate(() => {
      const target = document.createElement('button');
      target.textContent = 'Outside pointer target';
      target.style.cssText = 'position:fixed;left:0;top:100px;width:15px;height:40px;z-index:1';
      target.onclick = () => { target.textContent = 'Activated pointer target'; };
      document.body.append(target);
    });
    try {
      await page.mouse.click(7, 120);
      await panel.waitFor({ state: 'hidden' });
      await page.evaluate(async () => { for (let frame = 0; frame < 3; frame++) await new Promise(requestAnimationFrame); });
      if (await page.getByRole('button', { name: 'Activated pointer target', exact: true }).count()) throw new Error('Workspace dismissal activated the element under the pointer.');
      await page.getByRole('button', { name: messages[fixture.page === 'settings' ? 'settings' : 'hosting.feature'], exact: true }).click();
      await panel.waitFor();
    } finally {
      await page.getByRole('button', { name: /^(Outside|Activated) pointer target$/ }).evaluate(element => element.remove());
    }
  }
}
