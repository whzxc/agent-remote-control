import path from 'node:path';
import { representedTopologyRoots } from './topology.mjs';

export async function verifyPortraitTopology(page, fixture, messages, out, key, screenshots) {
  const taskCount = fixture.tasks.length, agentCount = fixture.agents.length;
  const sourceCount = fixture.sourceProducts.length;
  const read = async (sources, agents, tasks) => {
    // Playwright polls in the browser; serialize the shared pure coverage helper.
    const handle = await page.waitForFunction(`({ sources, agents, tasks }) => {
      const representedTopologyRoots = ${representedTopologyRoots.toString()};
      const topology = window.__ARC_VIEW_MODEL__().topology;
      return topology?.orientation === 'portrait' && !topology.orientationPending
        && representedTopologyRoots(topology, -1).length === sources
        && representedTopologyRoots(topology, 1).length === agents
        && topology.tasks.filter(task => task.position?.op > 0.99).length === tasks && topology;
    }`, { sources, agents, tasks }, { timeout: 5000 });
    const topology = await handle.jsonValue();
    await handle.dispose();
    return topology;
  };
  const center = (topology, target) => {
    const { sourceTop, agentBottom } = topology.primitives.portrait;
    if (topology.size.vw <= 520) {
      if (sourceTop !== 64) throw new Error('Mobile composition did not keep its top inset');
      return;
    }
    const positions = topology.tasks.filter(task => task.position?.op > 0.99).map(task => task.position);
    const anchor = target === 'tasks'
      ? (Math.min(...positions.map(task => task.y - task.height / 2)) + Math.max(...positions.map(task => task.y + task.height / 2))) / 2
      : (sourceTop + agentBottom) / 2;
    if (Math.abs(anchor - topology.size.vh / 2) > 1) throw new Error(`Portrait ${target} anchor is at ${anchor}`);
  };

  const open = await read(sourceCount, agentCount, taskCount);
  if (page.viewportSize().width <= 520) {
    // Regression: mobile node titles reserved outer columns and squeezed task content; the date/time header drifted left.
    const checkMobile = async () => {
      const issues = await page.evaluate(() => {
        const width = innerWidth, problems = [];
        const labels = [...document.querySelectorAll('.topology-node .graph-node-name')];
        if (labels.some(label => label.getClientRects().length)) problems.push('Mobile node titles still occupy space');
        const nodes = [...document.querySelectorAll('.topology-node .graph-node')].filter(node => !node.closest('[inert]'));
        if (nodes.some(node => !node.getAttribute('aria-label'))) problems.push('Mobile node lost its accessible name');
        const header = document.querySelector('.board-header').getBoundingClientRect();
        if (Math.abs(header.x + header.width / 2 - width / 2) > 1) problems.push('Mobile date/time header is not centered');
        const topology = window.__ARC_VIEW_MODEL__().topology;
        for (const task of topology.tasks.filter(task => task.position?.op > 0.99)) {
          const p = task.position;
          if (p.x - p.width < 0 || p.x > width) problems.push('Mobile task leaves the viewport');
          if (p.width < width - 120) problems.push('Mobile task still loses width to the outer label column');
        }
        if (document.documentElement.scrollWidth > width) problems.push('Mobile page scrolls horizontally');
        return problems;
      });
      if (issues.length) throw new Error(issues.join('; '));
    };
    await checkMobile();
    const initial = page.viewportSize();
    await page.setViewportSize({ width: 640, height: 1000 });
    await page.waitForFunction(() => {
      const topology = window.__ARC_VIEW_MODEL__().topology;
      return topology?.size.vw === 640 && !topology.orientationPending
        && [...document.querySelectorAll('.topology-node .graph-node-name')].some(label => label.getClientRects().length);
    });
    await read(sourceCount, agentCount, taskCount);
    await page.setViewportSize(initial);
    await page.waitForFunction(width => window.__ARC_VIEW_MODEL__().topology?.size.vw === width, initial.width);
    await read(sourceCount, agentCount, taskCount);
    await checkMobile();
  }
  if (open.groups.some(group => group.side === 1 && group.folded)
    || open.groups.some(group => group.side === -1 && group.folded) !== (taskCount === 4)) {
    throw new Error('Portrait did not compact the upper wing first under height pressure');
  }
  center(open, taskCount === 4 ? 'tasks' : 'composition');
  await page.getByTitle(messages['studio.clock'], { exact: true }).waitFor({ state: 'visible' });
  const board = page.getByRole('button', { name: messages['center.open'], exact: true });
  if (Boolean(await board.getAttribute('aria-description')) !== (taskCount > 0)) {
    throw new Error('Board trigger did not reflect the current activity');
  }
  if (fixture.claudeQuota) {
    const claude = page.getByRole('button', { name: /^Claude Code: / });
    await claude.getByRole('img', { name: new RegExp(`${messages.usageFiveHour}.*${messages.usageWeekly}`) }).waitFor({ state: 'visible', timeout: 5000 });
    const initial = page.viewportSize();
    const pitch = (topology, side) => {
      const roots = topology.nodes.filter(node => node.side === side && !node.parent);
      return (roots.at(-1).position.y - roots[0].position.y) / (roots.length - 1);
    };
    await page.setViewportSize({ ...initial, height: 800 });
    await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().topology?.size?.vh === 800);
    const shorter = await read(sourceCount, agentCount, taskCount);
    if ([-1, 1].some(side => pitch(open, side) <= pitch(shorter, side)) || shorter.groups.some(group => group.folded)) {
      throw new Error('Portrait did not use spare height for spacing before folding siblings');
    }
    await page.setViewportSize(initial);
    await page.waitForFunction(height => window.__ARC_VIEW_MODEL__().topology?.size?.vh === height, initial.height);
  }
  if (taskCount <= 1) {
    await board.press('Enter');
    const dialog = page.getByRole('dialog', { name: messages['center.title'], exact: true });
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 5000 });
    await board.evaluate(element => element.blur());
  }
  if (taskCount) return;

  const clearFocus = () => page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    document.activeElement?.blur();
    await new Promise(requestAnimationFrame);
  });
  for (const side of [-1, 1]) {
    const label = messages[side === -1 ? 'topology.sourceSide' : 'topology.agentSide'];
    const action = key => page.getByRole('button', { name: `${messages[key]} ${label}`, exact: true });
    await action('topology.collapse').press('Enter');
    const folded = await read(side === -1 ? 0 : sourceCount, side === 1 ? 0 : agentCount, 0);
    center(folded, 'composition');
    if (folded.primitives.hub.x !== open.primitives.hub.x || folded.nodes.some(node =>
      Math.abs(node.position.x - open.nodes.find(before => before.id === node.id && before.side === node.side).position.x) > 0.01)) {
      throw new Error(`Folding portrait wing ${side} moved the remaining topology horizontally`);
    }
    if (screenshots) {
      await clearFocus();
      const state = side === -1 ? 'sources-folded' : 'agents-folded';
      await page.screenshot({ path: path.join(out, `${key}-${state}.png`), animations: 'disabled' });
    }
    await action('topology.expand').press('Enter');
    center(await read(sourceCount, agentCount, 0), 'composition');
  }
  await clearFocus();
}
