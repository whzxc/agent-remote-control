export async function verifyDevices(page, fixture, messages) {
  const state = fixture.deviceLink.state;
  const c = key => messages[`device.${key}`];
  const devices = page.getByRole('button', { name: c('devices'), exact: true });
  const workspace = page.locator('.devices-workspace');
  const choose = async side => {
    const group = workspace.getByRole('radiogroup', { name: c('view'), exact: true });
    await group.getByRole('radio', { name: c(side === 'member' ? 'thisDevice' : 'members'), exact: true }).click();
  };
  const openDevice = name => workspace.getByRole('button', { name: `${c('open')}: ${name}`, exact: true }).click();
  const assertSnapshot = async check => {
    await page.waitForFunction(async check => {
      const { deviceSnapshot } = await import('/devices/state.ts');
      return new Function('snapshot', `return (${check})(snapshot)`)(deviceSnapshot.get());
    }, check.toString());
  };
  if (state.startsWith('experiment')) {
    const toggle = page.getByRole('switch', { name: c('deviceLink'), exact: true });
    if (await toggle.isChecked() !== fixture.deviceLink.enabled) throw new Error('Device link switch does not match its preference.');
    // Only the switch is present in the feature row.
    const row = page.locator('.device-experiment');
    if (await row.getByRole('button').count()) throw new Error('Device link settings embedded an action.');
    await toggle.click();
    await page.getByRole('switch', { name: c('deviceLink'), exact: true, checked: !fixture.deviceLink.enabled }).waitFor();
    await page.getByRole('button', { name: messages.backToHome, exact: true }).click();
    if (fixture.deviceLink.enabled) await devices.waitFor({ state: 'hidden' }); else await devices.waitFor();
    return;
  }
  if (state === 'navigation-disabled') {
    if (await devices.count()) throw new Error('Disabled Device link exposed navigation.');
    if (await page.getByRole('button', { name: /3 devices|3 台设备/ }).count()) throw new Error('Disabled Device link exposed the summary.');
    return;
  }
  if (state === 'navigation-enabled' || state === 'summary') {
    const chip = page.locator('.topology-device-summary').getByRole('button');
    await chip.waitFor();
    if (!/3.*2/.test(await chip.innerText())) throw new Error('Device summary omitted offline members or miscounted online members.');
    await (state === 'summary' ? chip : devices).click();
    await workspace.getByRole('heading', { name: c('devices'), exact: true }).waitFor();
    return;
  }
  await workspace.waitFor({ state: state.startsWith('pair-') || state.startsWith('revoke-') || state === 'address' ? 'attached' : 'visible' });
  if (state === 'controller') {
    await workspace.getByText(c('online'), { exact: true }).first().waitFor();
    await workspace.getByText(c('offline'), { exact: true }).waitFor();
    await openDevice('Quartz PC'); await workspace.getByText('Windows · x86_64', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await openDevice('Cedar Mac'); await workspace.getByText('macOS · arm64', { exact: true }).waitFor();
    await workspace.getByRole('button', { name: c('back'), exact: true }).click();
    await choose('member'); await workspace.getByText(c('unpaired'), { exact: true }).waitFor();
    await choose('controller');
  } else if (state === 'empty') {
    await workspace.getByText(c('empty'), { exact: true }).waitFor();
    await workspace.getByRole('button', { name: c('add'), exact: true }).click();
    const dialog = page.getByRole('dialog', { name: c('add'), exact: true });
    await dialog.getByRole('textbox', { name: c('pairing'), exact: true }).fill('arc-device:3:fixture');
    await dialog.getByRole('button', { name: c('pair'), exact: true }).click();
    const invalid = dialog.getByRole('textbox', { name: c('pairing'), exact: true });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-invalid') === 'true');
    if (!await invalid.getAttribute('aria-describedby')) throw new Error('Pair validation was not associated with its input.');
    await invalid.fill('arc-device:3:synthetic-approved-offer');
    await dialog.getByRole('button', { name: c('pair'), exact: true }).click();
    await dialog.getByRole('button', { name: c('done'), exact: true }).click();
    await workspace.getByText('Cedar Mac', { exact: true }).waitFor();
    await workspace.getByRole('button', { name: c('add'), exact: true }).click();
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
    await assertSnapshot(snapshot => snapshot.members[0].addressOverride === null);
  } else if (state.startsWith('revoke-')) {
    await page.getByRole('dialog').getByRole('button', { name: c('revoke'), exact: true }).click();
    await assertSnapshot(snapshot => snapshot.controller === null && (snapshot.members.length === 0 || snapshot.members.length === 2));
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  } else if (state.startsWith('pair-')) {
    const dialog = page.getByRole('dialog', { name: c('add'), exact: true });
    if (state === 'pair-waiting') {
      await dialog.getByRole('button', { name: c('waiting'), exact: true, disabled: true }).waitFor();
      await page.keyboard.press('Escape');
      await workspace.getByRole('button', { name: c('add'), exact: true }).click();
      await dialog.getByRole('button', { name: c('waiting'), exact: true, disabled: true }).waitFor();
    } else if (state === 'pair-success') await dialog.getByRole('button', { name: c('done'), exact: true }).waitFor();
    else if (state !== 'pair-input') await dialog.getByText(c(state === 'pair-invalid' ? 'invalidHint' : state.slice(5)), { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
  }
  const overflow = await workspace.evaluate(root => [...root.querySelectorAll('input,code,.device-identity,.device-actions')].filter(el => el.getBoundingClientRect().right > root.getBoundingClientRect().right + 1).map(el => el.tagName));
  if (overflow.length) throw new Error(`Device workspace overflow: ${overflow.join(', ')}`);
}
