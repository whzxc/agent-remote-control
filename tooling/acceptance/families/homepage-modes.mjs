import { readFile } from 'node:fs/promises';
import path from 'node:path';
export const bothThemes = fixture => !!fixture.homepage;
export const checks = [{ stage: 'verify', order: 18, visual: true, async run(context) {
  const { fixture, page, root, width } = context;
  if (!fixture.homepage) return;
  const messages = JSON.parse(await readFile(path.join(root, 'ui/locales', `${fixture.language}.json`), 'utf8'));
  const text = key => messages[`homepage.${key}`];
  const choose = async mode => {
    const radio = page.getByRole('radio', { name: text(mode), exact: true });
    if (await radio.count()) return radio.click();
    await page.getByRole('combobox', { name: text('mode'), exact: true }).click();
    await page.getByRole('option', { name: text(mode), exact: true }).click();
  };
  const mode = () => page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.mode);
  if (await mode() !== fixture.homepage.mode) throw new Error('Homepage mode did not restore the viewer preference.');
  const check = fixture.homepage.check;
  if (check === 'overflow') await page.getByRole('img', { name: text('attentionCount').replace('{count}', '101'), exact: true }).waitFor();
  if (check === 'idle') {
    await choose('tasks'); await page.getByRole('main', { name: text('tasks'), exact: true }).waitFor();
    if (await page.evaluate(() => JSON.parse(localStorage.getItem('arc.homepage-mode'))) !== 'tasks') throw new Error('Manual mode selection was not persisted for this viewer.');
    await choose('topology');
  } else if (check === 'focus') {
    await page.getByRole('button', { name: new RegExp(`^Codex.*${text('openTasks')}$`) }).click();
    await page.getByRole('button', { name: text('clearFilter'), exact: true }).waitFor();
    const matching = page.getByRole('article', { name: 'Inspect the dispatch queue', exact: true });
    await matching.waitFor();
    if (await page.getByRole('article', { name: 'Review the workspace changes', exact: true }).count()) throw new Error('Node filter included another Agent.');
    if (!await matching.getByRole('button', { name: `${text('openDetail')}: Inspect the dispatch queue`, exact: true }).evaluate(button => button === document.activeElement || button.closest('main').contains(document.activeElement))) throw new Error('Node navigation did not move keyboard focus into matching tasks.');
    await page.getByRole('button', { name: text('clearFilter'), exact: true }).click();
    await page.getByRole('article', { name: 'Review the workspace changes', exact: true }).waitFor();
    await choose('topology'); await choose('tasks');
    if (await page.getByRole('button', { name: text('clearFilter'), exact: true }).count()) throw new Error('Manual Tasks navigation retained a node filter.');
  } else if (check === 'accounts') {
    const group = page.getByRole('button', { name: new RegExp(`${messages['topology.expand']}$`) }).first();
    await group.focus(); await group.press('Enter');
    await page.keyboard.press('Escape');
    if (!await group.evaluate(button => button === document.activeElement)) throw new Error('Account disclosure did not restore its trigger focus.');
  } else if (check === 'tasks') {
    const feed = page.getByRole('main', { name: text('tasks'), exact: true });
    for (const task of fixture.tasks) await feed.getByRole('article', { name: task.title, exact: true }).waitFor();
    const card = feed.getByRole('article', { name: 'Inspect the dispatch queue', exact: true });
    if (width < 1000) {
      await card.getByRole('button', { name: text('activity'), exact: true }).click();
      await card.getByRole('list', { name: text('recentSteps'), exact: true }).waitFor();
      await card.getByRole('button', { name: text('hideActivity'), exact: true }).click();
    }
    if (fixture.homepage.remoteTaskCount) {
      await feed.getByRole('article', { name: 'Review remote workspace changes', exact: true }).waitFor();
      await feed.getByRole('article', { name: 'Inspect the remote storage index', exact: true }).waitFor();
      await feed.getByRole('article', { name: 'Choose the remote deployment window', exact: true }).getByRole('button', { name: text('answer'), exact: true }).click();
      await page.getByRole('dialog', { name: 'Choose the remote deployment window', exact: true }).waitFor();
      await page.keyboard.press('Escape');
    }
    const unread = feed.getByRole('article', { name: 'Summarize the queue', exact: true });
    await unread.getByRole('button', { name: `${text('markRead')}: Summarize the queue`, exact: true }).click();
    await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().homepage.tasks.some(task => task.group === 'recent'));
    if (await page.getByRole('dialog').count()) throw new Error('Marking a task read opened its detail.');
    await card.getByRole('button', { name: `${text('openDetail')}: Inspect the dispatch queue`, exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
  } else if (check === 'controller' || check === 'member') {
    const name = check === 'member' ? 'Anchor Mac' : 'Cedar Mac';
    await page.getByRole('button', { name, exact: true }).click();
    const panel = page.getByRole('dialog', { name, exact: true });
    await panel.waitFor();
    await panel.getByRole('button', { name: messages['device.revoke'], exact: true }).waitFor();
    if (check === 'member') {
      const toggle = panel.getByRole('switch', { name: text('upstreamSources'), exact: true });
      if (await toggle.isChecked()) throw new Error('Controller upstream sources must start off.');
      await toggle.click();
      await page.getByRole('button', { name: 'ChatGPT', exact: true }).waitFor();
    }
    await page.keyboard.press('Escape');
    if (check === 'controller') {
      await page.getByRole('button', { name: 'Quartz PC · Codex', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cedar Mac · Codex', exact: true }).waitFor();
      await page.getByRole('button', { name: new RegExp(`^Cedar Mac\\..*${text('openTasks')}$`) }).click();
      await page.getByRole('article', { name: 'Review remote workspace changes', exact: true }).waitFor();
      if (await page.getByRole('article', { name: 'Inspect the dispatch queue', exact: true }).count()) throw new Error('Device scope included a local task.');
      await choose('topology');
    } else {
      if (await page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.tasks.some(task => !!task.deviceId))) throw new Error('A controller-origin local task became a remote card on the member.');
    }
    await page.getByRole('button', { name: text('add'), exact: true }).click();
    await page.getByRole('menuitem', { name: messages['device.add'], exact: true }).click();
    await page.getByRole('dialog', { name: messages['device.add'], exact: true }).getByRole('textbox', { name: messages['device.pairing'], exact: true }).waitFor();
    await page.keyboard.press('Escape');
  }
  if (check !== 'tasks' && check !== 'focus' && fixture.tasks.length) {
    const before = await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology.nodes.map(node => [node.id, node.position.x, node.position.y]));
    await page.evaluate(async () => {
      const { trackedActivity } = await import('/state/activityBubbles.ts');
      trackedActivity.set(old => Object.fromEntries(Object.entries(old).map(([agent, sessions]) => [agent, sessions.map(session => ({ ...session, headline: 'Updated observation' }))])));
    });
    const after = await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology.nodes.map(node => [node.id, node.position.x, node.position.y]));
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Activity changed static configuration geometry.');
    if (await mode() !== 'topology') throw new Error('Activity switched homepage mode automatically.');
  }
  context.model = await page.evaluate(() => window.__ARC_VIEW_MODEL__());
} }];
