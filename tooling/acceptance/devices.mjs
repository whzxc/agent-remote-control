export async function verifyDevices(page, fixture, messages) {
  const state = fixture.deviceLink.state;
  const c = key => messages[`device.${key}`];
  const workspace = page.locator('.device-node-panel');
  const openLink = async () => {
    const action = page.getByRole('button', { name: c('deviceLink'), exact: true });
    await action.focus(); await action.press('Enter');
    await page.getByRole('dialog', { name: c('deviceLink'), exact: true }).waitFor();
  };
  const addDevice = async () => {
    if (!await workspace.count()) await openLink();
    await workspace.getByRole('button', { name: c('add'), exact: true }).click();
  };
  const choose = async side => {
    if (await workspace.count()) await page.keyboard.press('Escape');
    if (side === 'member') await openLink();
  };
  const openDevice = name => page.getByRole('button', { name, exact: true }).click();
  if (state.startsWith('experiment')) {
    const toggle = page.getByRole('switch', { name: c('deviceLink'), exact: true });
    if (await toggle.isChecked() !== fixture.deviceLink.enabled) throw new Error('Device link switch does not match its preference.');
    // Only the switch is present in the feature row.
    const row = page.locator('.device-experiment');
    if (await row.getByRole('button').count()) throw new Error('Device link settings embedded an action.');
    await toggle.click();
    await page.getByRole('switch', { name: c('deviceLink'), exact: true, checked: !fixture.deviceLink.enabled }).waitFor();
    await page.getByRole('button', { name: messages.backToHome, exact: true }).click();
    const endpoint = page.getByRole('button', { name: c('deviceLink'), exact: true });
    await endpoint.waitFor({ state: fixture.deviceLink.enabled ? 'hidden' : 'visible' });
    return;
  }
  if (!['controller', 'empty'].includes(state) && !state.startsWith('pair-')) await workspace.waitFor();
  if (state === 'controller') {
    await openDevice('Quartz PC'); await workspace.getByText('Windows · x86_64', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await openDevice('Cedar Mac'); await workspace.getByText('macOS · arm64', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await choose('member'); await workspace.getByText(c('unpaired'), { exact: true }).waitFor();
    await choose('controller');
  } else if (state === 'empty') {
    await addDevice();
    const dialog = page.getByRole('dialog', { name: c('add'), exact: true });
    await dialog.getByRole('textbox', { name: c('pairing'), exact: true }).fill('arc-device:3:fixture');
    await dialog.getByRole('button', { name: c('pair'), exact: true }).click();
    const invalid = dialog.getByRole('textbox', { name: c('pairing'), exact: true });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
    if (!await invalid.getAttribute('aria-describedby')) throw new Error('Pair validation was not associated with its input.');
    await invalid.fill('arc-device:3:synthetic-approved-offer');
    await dialog.getByRole('button', { name: c('pair'), exact: true }).click();
    await dialog.getByRole('button', { name: c('done'), exact: true }).click();
    await page.getByRole('button', { name: 'Cedar Mac', exact: true }).waitFor();
    await addDevice();
    if (await dialog.getByRole('textbox', { name: c('pairing'), exact: true }).inputValue()) throw new Error('A completed pairing did not reset for the next member.');
    await page.keyboard.press('Escape');
  } else if (state.startsWith('detail-')) {
    await workspace.getByText(state === 'detail-mac' ? 'macOS · arm64' : state === 'detail-windows' ? 'Windows · x86_64' : 'Linux · aarch64', { exact: true }).waitFor();
    await workspace.getByText(c('capabilities'), { exact: true }).waitFor();
  } else if (state === 'member-idle' || state === 'member-expired' || state === 'member-declined') {
    await workspace.getByRole('button', { name: c('createOffer'), exact: true }).click();
    await workspace.getByRole('textbox', { name: c('copy'), exact: true }).waitFor();
  } else if (state === 'member-offer') {
    await workspace.getByRole('textbox', { name: c('copy'), exact: true }).waitFor();
    await workspace.getByText(c('fingerprint'), { exact: true }).waitFor();
  } else if (state === 'member-pending') {
    await workspace.getByText('Anchor Mac', { exact: true }).waitFor();
    await workspace.getByText('b10cb10cb10cb10c b10cb10cb10cb10c b10cb10cb10cb10c b10cb10cb10cb10c', { exact: true }).waitFor();
    if (fixture.theme === 'dark') {
      await workspace.getByRole('button', { name: c('decline'), exact: true }).click();
      await workspace.getByText(c('offerDeclined'), { exact: true }).waitFor();
    } else {
      await workspace.getByRole('button', { name: c('approve'), exact: true }).click();
      await workspace.getByText(c('controlledBy'), { exact: true }).waitFor();
    }
  } else if (state === 'member-controlled') {
    await workspace.getByRole('button', { name: c('revoke'), exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: c('cancel'), exact: true }).click();
    await workspace.getByRole('button', { name: c('revoke'), exact: true }).waitFor();
  } else if (state === 'address') {
    const dialog = page.getByRole('dialog', { name: c('override'), exact: true });
    await dialog.getByRole('textbox', { name: 'Cedar Mac', exact: true }).fill('cedar-alt.local:7143');
    await dialog.getByRole('button', { name: c('save'), exact: true }).click();
    await workspace.getByText('cedar-alt.local:7143', { exact: true }).waitFor();
    await workspace.getByRole('button', { name: c('edit'), exact: true }).click();
    await dialog.getByRole('button', { name: c('clear'), exact: true }).click();
    await workspace.getByText(c('automatic'), { exact: true }).waitFor();
    await workspace.getByRole('button', { name: c('edit'), exact: true }).click();
    if (await dialog.getByRole('textbox', { name: 'Cedar Mac', exact: true }).inputValue()) throw new Error('Clearing an address did not persist when reopening the editor.');
    await page.keyboard.press('Escape');
  } else if (state.startsWith('revoke-')) {
    const peerName = state === 'revoke-controller' ? 'Anchor Mac' : 'Cedar Mac';
    const dialog = page.getByRole('dialog', { name: c('revokeTitle').replace('{name}', peerName), exact: true });
    await dialog.getByRole('button', { name: c('revoke'), exact: true }).click();
    await page.getByRole('button', { name: peerName, exact: true }).waitFor({ state: 'hidden' });
    await dialog.waitFor({ state: 'hidden' });
  } else if (state.startsWith('pair-')) {
    const dialog = page.getByRole('dialog', { name: c('add'), exact: true });
    if (state === 'pair-waiting') {
      const waiting = () => dialog.getByRole('button', { name: c('waiting'), exact: true, disabled: true });
      const stop = () => dialog.getByRole('button', { name: messages['layers.stopClose'], exact: true });
      await waiting().waitFor();
      await page.keyboard.press('Escape');
      const keep = dialog.getByRole('button', { name: messages['layers.keepOpen'], exact: true });
      await keep.waitFor();
      if (!await keep.evaluate(element => element === document.activeElement)) throw new Error('Keep open must receive focus while pairing runs.');
      await keep.click();
      await waiting().waitFor();
      await page.keyboard.press('Escape');
      await stop().click();
      await dialog.waitFor({ state: 'hidden' });
      // Reopening starts a clean form; another explicit submission starts a new attempt.
      await addDevice();
      const input = dialog.getByRole('textbox', { name: c('pairing'), exact: true });
      if (!await input.isEditable() || await input.inputValue()) throw new Error('Cancelled pairing was not reset.');
      await input.fill('arc-device:3:synthetic-approved-offer');
      await dialog.getByRole('button', { name: c('pair'), exact: true }).click();
      await waiting().waitFor();
      await page.keyboard.press('Escape');
      await stop().click();
      await dialog.waitFor({ state: 'hidden' });
      return;
    } else if (state === 'pair-success') await dialog.getByRole('button', { name: c('done'), exact: true }).waitFor();
    else if (state !== 'pair-input') await dialog.getByText(c(state === 'pair-invalid' ? 'invalidHint' : state.slice(5)), { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  if (!await workspace.count()) return;
  const overflow = await workspace.evaluate(root => [...root.querySelectorAll('input,code,.device-identity,.device-actions')].filter(el => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1).map(el => el.tagName));
  if (overflow.length) throw new Error(`Device panel overflow: ${overflow.join(', ')}`);
}
