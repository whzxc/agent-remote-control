import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const checks = [{ stage: 'verify', order: 18.5, visual: true, async run({ page, fixture, root }) {
  if (fixture.homepage?.check !== 'polish') return;
  const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const inspect = async () => {
    const errors = await page.evaluate(() => {
      const topology = window.__ARC_VIEW_MODEL__().topology, errors = [];
      if (document.querySelector('.node-capsule-unread,.device-node-status,.topology-group-dots')) errors.push('A topology status dot remains.');
      if (document.querySelector('[data-device-add]') || topology.nodes.some(node => node.endpoint)) errors.push('The device add tentacle remains.');
      if (topology.orientation === 'landscape') for (const parent of topology.nodes.filter(node => node.hasChildren && topology.nodes.some(child => child.parent === node.id && child.side === node.side))) {
        const key = JSON.stringify(['node', parent.side, parent.id]);
        const branch = [...document.querySelectorAll('[data-topology-node]')].find(branch => branch.getAttribute('data-topology-node') === key);
        if (!branch?.querySelector('.topology-outer-arc')?.getAttribute('d')) errors.push('A parent lost its child bracket.');
      }
      for (const node of topology.nodes) {
        if (node.hasChildren || node.group) continue;
        const key = JSON.stringify(['node', node.side, node.id]);
        const branch = [...document.querySelectorAll('[data-topology-node]')].find(branch => branch.getAttribute('data-topology-node') === key);
        if (branch && [...branch.querySelectorAll('.topology-outer-arc,[aria-label$=" arc"]')].some(path => path.getAttribute('d'))) errors.push('A leaf has an outward arc.');
        if (node.position.aop !== 0) errors.push('A leaf retained an outer arc primitive.');
      }
      for (const node of document.querySelectorAll('.topology-node')) {
        const id = node.getAttribute('data-node-id');
        const view = topology.nodes.find(view => view.id === id);
        if (view?.hasChildren && node.querySelector('.node-capsule-tasks')) errors.push('A parent exposes a task segment.');
      }
      return errors;
    });
    if (errors.length) throw new Error([...new Set(errors)].join(' '));
  };
  const positions = () => page.evaluate(() => JSON.stringify(window.__ARC_VIEW_MODEL__().topology.nodes.map(node => [node.id, node.position.x, node.position.y, node.position.size])));
  await inspect();
  // Reveal configuration members before exercising their individual controls.
  const folded = await page.evaluate(() => {
    const topology = window.__ARC_VIEW_MODEL__().topology;
    return topology.groups.filter(group => group.side === 1 && !group.parent && group.folded)
      .map(group => topology.nodes.find(node => node.id === group.id)?.label).filter(Boolean);
  });
  for (const label of folded) await page.getByRole('button', { name: `${label} · ${messages['topology.expand']}`, exact: true }).click();
  const leaves = await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology.nodes.filter(node => !node.hasChildren && !node.group));
  if (!leaves.some(node => node.attention) || !leaves.some(node => node.unread?.length)) throw new Error('Fixture needs attention and unread leaves.');
  for (const node of leaves) {
    const logo = page.locator(`[data-node-id=${JSON.stringify(node.id)}]`).getByRole('button', { expanded: false }).first();
    await logo.hover(); await inspect();
    await logo.focus(); await inspect();
  }
  const taskGroups = await page.evaluate(() => [...new Set(window.__ARC_VIEW_MODEL__().homepage.tasks.map(task => task.group))]);
  for (const state of ['running','needs-me','unread','unconfirmed']) if (!taskGroups.includes(state)) throw new Error(`Fixture is missing ${state}.`);
  const capsules = page.getByRole('button', { name: new RegExp(`${messages['homepage.openTasks']}$`) });
  if (!await capsules.count()) throw new Error('A running leaf has no task segment.');
  const leaf = page.getByRole('button', { name: /OpenCode.*Connected/ }).first();
  await leaf.hover(); await inspect();
  await leaf.focus(); await inspect();
  const before = await positions();
  await leaf.press('Enter');
  const panel = page.getByRole('dialog').last(); await panel.waitFor();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  if (Math.abs(box.x + box.width / 2 - viewport.width / 2) > 1) throw new Error('Node panel is not horizontally centered.');
  await inspect();
  if (await positions() !== before) throw new Error('Opening a leaf panel changed topology geometry.');
  if (await page.getByRole('group', { name: /OpenCode/ }).getByRole('button', { name: /Collapse|Expand/ }).count()) throw new Error('A leaf exposes arc collapse controls.');
  await page.keyboard.press('Escape'); await panel.waitFor({ state: 'hidden' });
  const parentActions = page.getByRole('group', { name: 'Codex', exact: true });
  const collapse = parentActions.getByRole('button', { name: `${messages['topology.collapse']} Codex`, exact: true });
  await collapse.focus(); await collapse.press('Enter'); await inspect();
  const expand = parentActions.getByRole('button', { name: `${messages['topology.expand']} Codex`, exact: true });
  await expand.focus(); await expand.press('Enter'); await inspect();
  const action = page.getByRole('button', { name: messages['device.deviceLink'], exact: true });
  if (!await page.locator('.hub-arc-bottom').getByRole('button', { name: messages['device.deviceLink'], exact: true }).count()) throw new Error('Device link is not on the lower ARC action group.');
  await action.focus(); await action.press('Enter');
  const devicePanel = page.getByRole('dialog', { name: messages['device.deviceLink'], exact: true }); await devicePanel.waitFor();
  const deviceBox = await devicePanel.boundingBox();
  if (Math.abs(deviceBox.x + deviceBox.width / 2 - viewport.width / 2) > 1) throw new Error('Device link panel is not centered.');
  await devicePanel.getByRole('button', { name: messages['device.add'], exact: true }).click();
  const pair = page.getByRole('dialog', { name: messages['device.add'], exact: true }); await pair.waitFor();
  const pairBox = await pair.boundingBox();
  if (Math.abs(pairBox.x + pairBox.width / 2 - viewport.width / 2) > 1) throw new Error('Pairing dialog is not centered.');
  await page.keyboard.press('Escape'); await pair.waitFor({ state: 'hidden' });
  await page.keyboard.press('Escape'); await devicePanel.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.classList.contains('hub-device-link'));
  await inspect();
} }];
