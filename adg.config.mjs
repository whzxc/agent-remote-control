import { readFileSync } from 'node:fs';
import path from 'node:path';

// Compare preparations use the same fixture data and public controls as accept:ui.
const prepared = {
  'board-ax-closed': { scenario: 'coordination-ax-light', axClosed: true },
  'board-ax-detail': { scenario: 'coordination-ax-light', axClosed: true },
  'approval-permission': { scenario: 'approval', task: '阅读项目说明 · 打开执行时间线' },
  'approval-question': { scenario: 'task-states', task: 'Waiting for input · 打开执行时间线' },
  'agent-account-edit': { scenario: 'agent-platform-lifecycle', accountAction: 'edit' },
  'agent-account-remove': { scenario: 'agent-platform-lifecycle', accountAction: 'remove' },
  'agent-account-claude-add': { scenario: 'agent-platform-lifecycle', accountAction: 'add' },
  'agent-account-reauth': { scenario: 'agent-platform-lifecycle', accountAction: 'reauth' },
  'agent-account-reauth-waiting': { scenario: 'agent-platform-lifecycle', accountAction: 'waiting' },
  'agent-account-reauth-expired': { scenario: 'agent-platform-lifecycle', accountAction: 'expired' },
  'quota-overview': { scenario: 'agent-panel' },
  'board-unavailable': { scenario: 'coordination-unavailable' },
  'portrait-topology-sources-folded': { scenario: 'portrait-topology-0', side: -1 },
  'portrait-topology-agents-folded': { scenario: 'portrait-topology-0', side: 1 },
};

export default {
  requires: '>=0.5.0',
  design: 'design',
  output: 'output/design',
  compare: {
    port: 5188,
    viewport: '1280x800',
    async start({ port, root }) {
      const { createServer } = await import('vite');
      const server = await createServer({ mode: 'fixtures', cacheDir: path.join(root, 'node_modules/.vite-adg'), configFile: path.join(root, 'vite.config.ts'), server: { port, strictPort: true }, logLevel: 'error' });
      await server.listen();
      return () => server.close();
    },
    fixture(reference) {
      const [name, runTheme] = reference.split('@');
      const scenario = prepared[name]?.scenario ?? name;
      const fixture = JSON.parse(readFileSync(new URL(`./tooling/acceptance/scenarios/${scenario}.json`, import.meta.url), 'utf8'));
      return {
        url: `/?scenario=${encodeURIComponent(scenario)}&theme=${runTheme ?? fixture.theme ?? 'light'}`,
        theme: (runTheme ?? fixture.theme) === 'dark' ? 'dark' : 'light',
        locale: fixture.language === 'zh-CN' ? 'zh-CN' : 'en-US',
        clock: fixture.clock ?? '2026-01-01T00:00:00Z',
        ...(fixture.timezone ? { timezone: fixture.timezone } : {}),
        ...(scenario.startsWith('portrait-topology-') ? { timezone: 'Asia/Shanghai' } : {}),
      };
    },
    async ready(page, reference) {
      const [name] = reference.split('@');
      const preparation = prepared[name];
      const scenario = preparation?.scenario ?? name;
      await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, scenario, { timeout: 15000 });
      const error = await page.evaluate(() => document.documentElement.dataset.scenarioError);
      if (error) throw new Error(`ARC fixture ${name}: ${error}`);
      if (['agent-panel-loading', 'agent-platform-loading', 'source-panel-loading'].includes(name)) {
        await page.getByRole('dialog').getByText('正在加载…', { exact: true }).waitFor();
      }
      if (scenario.startsWith('codex-account-add-')) {
        await page.getByRole('button', { name: '添加账号', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: '添加 Codex 账号', exact: true });
        await dialog.waitFor();
        if (!scenario.includes('-oauth-')) await dialog.getByRole('radio', { name: '导入凭据', exact: true }).click();
        if (scenario.includes('-external-')) await dialog.getByRole('radio', { name: '外部托管', exact: true }).click();
      }
      if (preparation?.task) {
        // Scope panel rows so an identically named topology bubble cannot win.
        const host = scenario === 'approval' ? page : page.locator('.agent-overview-layer');
        await host.getByRole('button', { name: preparation.task, exact: true }).press('Enter');
        await page.locator('.task-detail-layer').waitFor();
        await page.waitForFunction(() => window.__ARC_VIEW_MODEL__().taskDetail?.timeline, undefined, { timeout: 5000 });
        if (name.startsWith('approval-')) await page.locator('.request-entry').getByRole('button', { name: '打开', exact: true }).waitFor();
      }
      if (preparation?.axClosed) {
        const messages = JSON.parse(readFileSync(new URL('./ui/locales/zh-CN.json', import.meta.url), 'utf8'));
        await page.getByRole('button', { name: messages['center.open'], exact: true }).click();
        await page.getByRole('radio', { name: 'AX', exact: true }).click();
        // AX counts load asynchronously; SingleChoice may expose pills or a dropdown.
        await page.getByText(messages['center.ax.open'].replace('{count}', '5'), { exact: true }).filter({ visible: true }).first().waitFor();
        await page.evaluate(() => document.fonts.ready);
        const dropdown = page.getByRole('combobox', { name: messages['center.ax.filter'], exact: true });
        if (await dropdown.count()) await dropdown.click();
        const closed = messages['center.ax.closed'].replace('{count}', '12');
        await page.getByRole('radio', { name: closed, exact: true }).or(page.getByRole('option', { name: closed, exact: true })).click();
      }
      const accountAction = preparation?.accountAction;
      if (accountAction === 'edit' || accountAction === 'remove') {
        const card = page.getByRole('region', { name: accountAction === 'edit' ? 'Team' : 'Studio', exact: true });
        await card.getByRole('button', { name: accountAction === 'edit' ? '编辑别名' : '移除账号', exact: true }).click();
      } else if (accountAction) {
        if (accountAction === 'add') await page.getByRole('button', { name: '添加账号', exact: true }).click();
        else await page.getByRole('region', { name: 'Studio', exact: true }).getByRole('button', { name: '重新登录', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: accountAction === 'add' ? '添加 Claude Code 账号' : '重新登录 · Studio' });
        await dialog.getByRole('combobox', { name: '登录浏览器', exact: true }).click();
        await page.getByRole('option', { name: 'Google Chrome · Profile A', exact: true }).click();
        if (accountAction === 'waiting' || accountAction === 'expired') {
          await dialog.getByRole('button', { name: '开始登录', exact: true }).click();
          const code = dialog.getByRole('textbox', { name: '授权码（浏览器显示时填写）', exact: true });
          await code.waitFor();
          if (accountAction === 'expired') {
            await code.fill('fixture-expired-code');
            await dialog.getByRole('button', { name: '提交授权码', exact: true }).click();
            await dialog.getByText('登录链接已过期', { exact: true }).waitFor();
          }
        }
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
