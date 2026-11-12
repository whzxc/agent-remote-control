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
  if (fixture.homepage.mode === 'tasks') {
    const feed = await page.getByRole('main', { name: text('tasks'), exact: true }).boundingBox();
    const nav = await page.locator('.navigation-capsule').boundingBox();
    if (feed && nav && feed.y + feed.height > nav.y) throw new Error('Tasks scroll area overlaps the navigation capsule.');
  }
  if (fixture.homepage.check === 'controller' && width >= 1000) {
    const clipped = await page.locator('.node-capsule').evaluateAll(nodes => nodes.some(node => {
      const box = node.getBoundingClientRect();
      return box.left < 16 || box.right > innerWidth - 16;
    }));
    if (clipped) throw new Error('A configured device topology capsule is clipped horizontally.');
  }
  const openDeviceLink = async () => {
    const action = page.getByRole('button', { name: messages['device.deviceLink'], exact: true });
    await action.focus(); await action.press('Enter');
    await page.getByRole('dialog', { name: messages['device.deviceLink'], exact: true }).waitFor();
  };
  const mode = () => page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.mode);
  if (await mode() !== fixture.homepage.mode) throw new Error('Homepage mode did not restore the viewer preference.');
  const check = fixture.homepage.check;
  const reveal = async name => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const target = page.getByRole('button', { name, exact: true });
      if (await target.count() && await target.evaluate(button => !button.closest('[inert]'))) return target;
      const label = await page.evaluate(() => {
        const topology = window.__ARC_VIEW_MODEL__().topology;
        const group = topology.groups.find(group => group.side === 1 && !group.parent && group.folded);
        return group && topology.nodes.find(node => node.id === group.id)?.label;
      });
      const group = label ? page.getByRole('button', { name: `${label} · ${messages['topology.expand']}`, exact: true })
        : page.getByRole('button', { name: new RegExp(`${messages['topology.expand']}$`) }).first();
      if (!await group.count()) throw new Error(`Configured node is unavailable: ${name}`);
      await group.click();
    }
    throw new Error(`Configured node stayed folded: ${name}`);
  };
  if (check === 'portrait-device') {
    const issues = await page.evaluate(() => {
      const hub = document.querySelector('.topology-hub').getBoundingClientRect();
      const pan = document.querySelector('.topology-viewport').getBoundingClientRect();
      const protectedMark = { left: hub.left + hub.width / 4, right: hub.right - hub.width / 4, top: hub.top, bottom: hub.bottom };
      const headerBottom = Math.max(...[...document.querySelectorAll('.board-header, .homepage-mode-switch')].map(node => node.getBoundingClientRect().bottom));
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      const issues = [];
      for (const node of document.querySelectorAll('.node-capsule, .topology-group-capsule, .capsule-graph-node .graph-node-name')) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height || node.closest('[inert]')) continue;
        if (box.left < 0 || box.right > innerWidth || box.top < pan.top || box.bottom > pan.bottom) issues.push('A node, account group or label is clipped.');
        if (overlaps(box, hub)) issues.push('A node or label overlaps ARC.');
        if (box.top < headerBottom) issues.push('A node or label overlaps the header.');
      }
      const activeSvg = document.querySelector('.topology-wires[data-inactive=false]');
      const svg = activeSvg.getBoundingClientRect();
      for (const path of activeSvg.querySelectorAll('path')) {
        if (!path.getAttribute('d')) continue;
        const length = path.getTotalLength();
        for (let at = 0; at <= length; at += 4) {
          const point = path.getPointAtLength(at), x = point.x + svg.x, y = point.y + svg.y;
          if (y < headerBottom || x < 0 || x > innerWidth) issues.push('A connector leaves the clear topology area.');
          if (x > protectedMark.left && x < protectedMark.right && y > protectedMark.top && y < protectedMark.bottom) issues.push('A connector crosses ARC.');
        }
      }
      return issues;
    });
    if (issues.length) throw new Error([...new Set(issues)].join(' '));
    const device = await reveal('MacBook · Codex');
    await device.click();
    await page.getByRole('dialog').getByText(messages['device.online'], { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    if (await page.getByRole('button', { name: new RegExp(`^MacBook.*${text('unconfirmed')}`) }).count()) throw new Error('Online device inherited unknown task status.');
    const representedRoots = await page.evaluate(() => {
      const topology = window.__ARC_VIEW_MODEL__().topology;
      return new Set([...topology.nodes.filter(node => node.side === 1 && !node.parent && !node.group && !node.endpoint).map(node => node.id),
        ...topology.groups.filter(group => group.side === 1 && !group.parent && group.folded).flatMap(group => group.members)]).size;
    });
    if (representedRoots !== 5) throw new Error('The composition lost a configured Agent or device.');
    await openDeviceLink();
    await page.getByRole('dialog').getByRole('button', { name: messages['device.add'], exact: true }).waitFor();
    await page.keyboard.press('Escape');
  }
  if (check === 'remote-error') {
    await page.waitForFunction(async () => {
      const { deviceTasks } = await import('/devices/tasks.ts');
      return !!deviceTasks.get()['c34d'.repeat(16)]?.error;
    });
    const tasks = await page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.tasks);
    if (!tasks.some(task => task.deviceId === 'd45e'.repeat(16) && task.group === 'running')
        || tasks.some(task => task.deviceId === 'c34d'.repeat(16) && task.group !== 'unconfirmed')) throw new Error('A malformed device read affected other devices or retained live claims.');
  }
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
    if (!await group.count()) {
      if (!await page.getByRole('button', { name: /Personal|Pro|Review|Studio/ }).count()) throw new Error('Account nodes and their disclosure are unavailable.');
    } else {
    const trigger = await group.elementHandle();
    await group.focus(); await group.press('Enter');
    await page.keyboard.press('Enter');
    const panel = page.getByRole('dialog').last();
    await panel.waitFor();
    await panel.getByRole('button', { name: messages.expandPanelWidth, exact: true }).click();
    if (await page.evaluate(() => window.__ARC_VIEW_MODEL__().topology.groups.every(group => group.folded))) throw new Error('A member panel pointer folded its open topology group.');
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    await page.keyboard.press('Escape');
    if (!await trigger.evaluate(button => button === document.activeElement)) throw new Error('Account disclosure did not restore its trigger focus.');
    }
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
    await (await reveal(name)).click();
    const panel = page.getByRole('dialog', { name, exact: true });
    await panel.waitFor();
    await panel.getByRole('button', { name: messages['device.revoke'], exact: true }).waitFor();
    await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().topology.panel?.width > 0);
    if (check === 'member') {
      const toggle = panel.getByRole('switch', { name: text('upstreamSources'), exact: true });
      if (await toggle.isChecked()) throw new Error('Controller upstream sources must start off.');
      await toggle.click();
    }
    await page.keyboard.press('Escape');
    if (check === 'member') await page.getByRole('button', { name: 'ChatGPT', exact: true }).waitFor();
    if (check === 'controller') {
      await (await reveal('Quartz PC · Codex')).waitFor();
      await (await reveal('Cedar Mac · Codex')).waitFor();
      await page.getByRole('button', { name: new RegExp(`^Cedar Mac.*Codex\\..*${text('openTasks')}$`) }).click();
      await page.getByRole('article', { name: 'Review remote workspace changes', exact: true }).waitFor();
      if (await page.getByRole('article', { name: 'Inspect the dispatch queue', exact: true }).count()) throw new Error('Device scope included a local task.');
      await choose('topology');
    } else {
      if (await page.evaluate(() => window.__ARC_VIEW_MODEL__().homepage.tasks.some(task => !!task.deviceId))) throw new Error('A controller-origin local task became a remote card on the member.');
    }
    await openDeviceLink();
    await page.getByRole('dialog').getByRole('button', { name: messages['device.add'], exact: true }).click();
    await page.getByRole('dialog', { name: messages['device.add'], exact: true }).getByRole('textbox', { name: messages['device.pairing'], exact: true }).waitFor();
    await page.keyboard.press('Escape');
  }
  if (fixture.homepage.mode === 'topology' && check !== 'focus' && fixture.tasks.length) {
    await page.waitForFunction(async () => {
      const positions = () => JSON.stringify(window.__ARC_VIEW_MODEL__().topology.nodes.map(node => [node.id, node.position.x, node.position.y]));
      const before = positions();
      await new Promise(requestAnimationFrame);
      return !window.__ARC_VIEW_MODEL__().topology.orientationPending && positions() === before;
    });
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
