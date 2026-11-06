import { readFileSync } from 'node:fs';
import path from 'node:path';

// Compare preparations use the same fixture data and public controls as accept:ui.
const prepared = {
  'approval-permission': { scenario: 'approval', task: '阅读项目说明 · 打开执行时间线' },
  'approval-question': { scenario: 'task-states', task: 'Waiting for input · 打开执行时间线' },
  'task-detail-failed': { scenario: 'task-states', task: 'Failed task · 打开执行时间线' },
  'agent-platform-accounts': { scenario: 'brand-accounts-light' },
  'quota-overview': { scenario: 'agent-panel' },
  'board-unavailable': { scenario: 'coordination-unavailable' },
  'portrait-topology-sources-folded': { scenario: 'portrait-topology-0', side: -1 },
  'portrait-topology-agents-folded': { scenario: 'portrait-topology-0', side: 1 },
};

export default {
  requires: '>=0.3.3',
  design: 'design',
  output: 'output/design',
  compare: {
    port: 5188,
    viewport: '1280x800',
    async start({ port, root }) {
      const { createServer } = await import('vite');
      const server = await createServer({ configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error' });
      await server.listen();
      return () => server.close();
    },
    fixture(name) {
      const scenario = prepared[name]?.scenario ?? name;
      const fixture = JSON.parse(readFileSync(new URL(`./tooling/acceptance/scenarios/${scenario}.json`, import.meta.url), 'utf8'));
      return {
        url: `/?scenario=${encodeURIComponent(scenario)}`,
        theme: fixture.theme === 'dark' ? 'dark' : 'light',
        locale: fixture.language === 'zh-CN' ? 'zh-CN' : 'en-US',
        clock: '2026-01-01T00:00:00Z',
        ...(scenario.startsWith('portrait-topology-') ? { timezone: 'Asia/Shanghai' } : {}),
      };
    },
    async ready(page, name) {
      const preparation = prepared[name];
      const scenario = preparation?.scenario ?? name;
      await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, scenario, { timeout: 15000 });
      const error = await page.evaluate(() => document.documentElement.dataset.scenarioError);
      if (error) throw new Error(`ARC fixture ${name}: ${error}`);
      if (preparation?.task) {
        // Scope panel rows so an identically named topology bubble cannot win.
        const host = scenario === 'approval' ? page : page.locator('.agent-overview-layer');
        await host.getByRole('button', { name: preparation.task, exact: true }).press('Enter');
        await page.locator('.task-detail-layer').waitFor();
        await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().taskDetail?.timeline, undefined, { timeout: 5000 });
        if (name.startsWith('approval-')) await page.locator('.request-entry').getByRole('button', { name: '打开', exact: true }).waitFor();
      }
      if (name === 'agent-platform-accounts') {
        await page.locator('[data-agent-platform="claude"]').getByRole('button', { name: 'Claude Code', exact: true }).press('Enter');
        await page.locator('.agent-platform-view').waitFor();
      }
      if (name === 'quota-overview') {
        await page.keyboard.press('Escape');
        await page.locator('.activity-panel').waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '管理 Agent', exact: true }).waitFor();
      }
      if (name === 'board-unavailable') {
        await page.getByRole('button', { name: 'Open board', exact: true }).click();
        await page.getByRole('dialog', { name: 'Board', exact: true }).getByText(/SCENARIO_BOARD_UNAVAILABLE/).waitFor();
      }
      if (preparation?.side) {
        const side = preparation.side;
        await page.getByRole('button', { name: side === -1 ? 'Collapse control sources' : 'Collapse Agents', exact: true }).press('Enter');
        await page.waitForFunction(side => {
          const topology = window.__ARC_VIEW_MODEL__().topology;
          return topology?.orientation === 'portrait' && !topology.orientationPending
            && topology.nodes.filter(node => node.side === side && !node.parent && node.position).length === 0;
        }, side, { timeout: 5000 });
        await page.evaluate(async () => {
          await new Promise(requestAnimationFrame);
          document.activeElement?.blur();
          await new Promise(requestAnimationFrame);
        });
      }
    },
    block: ['**/api/**'],
  },
};
