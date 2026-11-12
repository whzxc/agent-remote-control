/** Browser-only checks for workspace placement, retained height and outside-click consumption. */
export async function verifyWorkspace(page, fixture, messages, width, height) {
  const panel = page.locator('.layer-panel');
  if (!await panel.count()) return;
  await panel.waitFor();
  const box = await panel.boundingBox();
  // Updater fixtures install an IPC mock after startup; it does not change the app's runtime mode.
  const top = await page.evaluate(async () => (await import('/platform.ts')).isDesktop ? 48 : 20);
  const size = 960;
  const expectedWidth = width < 760 || height > width ? width - 32 : Math.min(size, width - 32);
  if (!box || Math.abs(box.x - (width - expectedWidth) / 2) > 1 || box.y < top - 1
    || Math.abs(box.width - expectedWidth) > 1 || box.y + box.height > height - 15) {
    throw new Error(`Workspace must use its center slot: expected ${expectedWidth}px wide within the vertical margins above y=${top}, got ${JSON.stringify(box)}.`);
  }
  if (fixture.page === 'relay-hosting' && box.y + box.height >= height - 17) {
    throw new Error('Empty Relay hosting must fit its content.');
  }
  if (fixture.page === 'relay-hosting' && Math.abs(box.y - (top + (height - 16 - top - box.height) / 2)) > 2) throw new Error('The content-fit workspace must center at open.');
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
  if (fixture.page === 'settings' && !fixture.settingsExperimental) {
    await page.evaluate(() => {
      window.__panelSwitchCheck = { shell: document.querySelector('.layer-panel'), minimum: 1 };
      window.__panelSwitchObserver = new MutationObserver(() => { window.__panelSwitchCheck.minimum = Math.min(window.__panelSwitchCheck.minimum, document.querySelectorAll('.layer-panel').length); });
      window.__panelSwitchObserver.observe(document.body, { childList: true, subtree: true });
    });
    await page.locator('.navigation-capsule').getByRole('button', { name: messages.permissionsTitle, exact: true }).click();
    await page.locator('.permissions-page').waitFor();
    const continuous = await page.evaluate(() => window.__panelSwitchCheck.minimum > 0 && window.__panelSwitchCheck.shell === document.querySelector('.layer-panel'));
    if (!continuous) throw new Error('Capsule replacement unmounted the shell or passed through zero panels.');
    await page.locator('.navigation-capsule').getByRole('button', { name: messages.settings, exact: true }).click();
    await page.locator('.settings-page').waitFor();
    await page.evaluate(() => window.__panelSwitchObserver.disconnect());
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
