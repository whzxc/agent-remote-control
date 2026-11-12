export async function readPortraitTopology(page, { sources, agents }) {
  const handle = await page.waitForFunction(`(() => {
    const topology = window.__ARC_VIEW_MODEL__().topology;
    if (!topology || topology.orientation !== 'portrait' || topology.orientationPending) return false;
    const roots = side => [...new Set([
      ...topology.nodes.filter(node => node.side === side && !node.parent && !node.group).map(node => node.id),
      ...topology.groups.filter(group => group.side === side && !group.parent && group.folded).flatMap(group => group.members),
    ])];
    return roots(-1).length === ${sources} && roots(1).length === ${agents} ? topology : false;
  })()`);
  try { return await handle.jsonValue(); } finally { await handle.dispose(); }
}

import { representedTopologyRoots } from './topology.mjs';

export async function verifyPortraitTopology(page, fixture, messages) {
  await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().topology?.orientation === 'portrait');
  const topology = await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology);
  if (representedTopologyRoots(topology, 1).length !== fixture.agents.length
      || representedTopologyRoots(topology, -1).length !== fixture.sourceProducts.length) {
    throw new Error('Static topology omitted a configured root.');
  }
  const anchors = topology.nodes.map(node => [node.side, node.id, node.position.x, node.position.y]);
  await page.evaluate(async () => {
    const { trackedActivity } = await import('/state/activityBubbles.ts');
    trackedActivity.set(old => Object.fromEntries(Object.entries(old).map(([agent, sessions]) => [agent,
      sessions.map(session => ({ ...session, headline: 'Updated observation', phase: 'thinking' }))])));
  });
  const after = await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology.nodes.map(node => [node.side, node.id, node.position.x, node.position.y]));
  if (JSON.stringify(after) !== JSON.stringify(anchors)) throw new Error('Task activity moved static topology anchors.');
  await page.getByLabel(messages['studio.clock'], { exact: true }).waitFor();
  if (fixture.topologyAccounts === 'dense') {
    const disclosure = page.getByRole('button', { name: new RegExp(`${messages['topology.expand']}$`) }).first();
    const trigger = await disclosure.elementHandle();
    await disclosure.scrollIntoViewIfNeeded();
    await disclosure.focus(); await disclosure.press('Enter');
    await page.getByRole('button', { name: /^Codex Pro/ }).first().waitFor();
    await page.keyboard.press('Escape');
    if (!await trigger.evaluate(element => element === document.activeElement)) throw new Error('Account disclosure did not restore keyboard focus.');
  }
  const chooseTasks = page.getByRole('radio', { name: messages['homepage.tasks'], exact: true });
  if (await chooseTasks.count()) await chooseTasks.click();
  else {
    await page.getByRole('combobox', { name: messages['homepage.mode'], exact: true }).click();
    await page.getByRole('option', { name: messages['homepage.tasks'], exact: true }).click();
  }
  const feed = page.getByRole('main', { name: messages['homepage.tasks'], exact: true });
  await feed.waitFor();
  for (const task of fixture.tasks) await feed.getByRole('article', { name: task.title, exact: true }).waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Static topology caused page-level horizontal overflow.');
}
