import { readFileSync } from 'node:fs';
import path from 'node:path';

export default {
  requires: '>=0.3.0',
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
      const fixture = JSON.parse(readFileSync(new URL(`./tooling/acceptance/scenarios/${name}.json`, import.meta.url), 'utf8'));
      return {
        url: `/?scenario=${encodeURIComponent(name)}`,
        theme: fixture.theme === 'dark' ? 'dark' : 'light',
        locale: fixture.language === 'zh-CN' ? 'zh-CN' : 'en-US',
        clock: '2026-01-01T00:00:00Z',
      };
    },
    async ready(page, name) {
      await page.waitForFunction(name => document.documentElement.dataset.scenarioError || document.documentElement.dataset.scenarioReady === name, name, { timeout: 15000 });
      const error = await page.evaluate(() => document.documentElement.dataset.scenarioError);
      if (error) throw new Error(`ARC fixture ${name}: ${error}`);
    },
    block: ['**/api/**'],
  },
};
