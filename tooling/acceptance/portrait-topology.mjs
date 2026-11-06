import path from 'node:path';

export async function verifyPortraitTopology(page, taskCount, messages, out, key, screenshots) {
  const read = async (sources, agents, tasks) => {
    const handle = await page.waitForFunction(({ sources, agents, tasks }) => {
      const topology = window.__ARC_VIEW_MODEL__().topology;
      return topology?.orientation === 'portrait' && !topology.orientationPending
        && topology.nodes.filter(node => node.side === -1 && node.position).length === sources
        && topology.nodes.filter(node => node.side === 1 && node.position).length === agents
        && topology.tasks.filter(task => task.position?.op > 0.99).length === tasks && topology;
    }, { sources, agents, tasks }, { timeout: 5000 });
    const topology = await handle.jsonValue();
    await handle.dispose();
    return topology;
  };
  const center = (topology, target) => {
    const { sourceTop, agentBottom } = topology.primitives.portrait;
    const positions = topology.tasks.filter(task => task.position?.op > 0.99).map(task => task.position);
    const anchor = target === 'tasks'
      ? (Math.min(...positions.map(task => task.y - task.height / 2)) + Math.max(...positions.map(task => task.y + task.height / 2))) / 2
      : (sourceTop + agentBottom) / 2;
    if (Math.abs(anchor - topology.size.vh / 2) > 1) throw new Error(`Portrait ${target} anchor is at ${anchor}`);
  };

  const open = await read(4, 3, taskCount);
  if (open.nodes.some(node => node.side === 1 && node.stacked)
    || open.nodes.some(node => node.side === -1 && node.stacked) !== (taskCount === 4)) {
    throw new Error('Portrait did not compact the upper wing first under height pressure');
  }
  center(open, taskCount === 4 ? 'tasks' : 'composition');
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
    const folded = await read(side === -1 ? 0 : 4, side === 1 ? 0 : 3, 0);
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
    center(await read(4, 3, 0), 'composition');
  }
  await clearFocus();
}
