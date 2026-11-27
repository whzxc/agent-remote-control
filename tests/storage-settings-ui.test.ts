import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer, type ViteDevServer } from 'vite';
import type { Root } from 'react-dom/client';
import { act, createElement as h } from 'react';
import { within, fireEvent } from '@testing-library/dom';

async function withStorageUI(
  url: string,
  fetchImpl: typeof fetch,
  run: (context: { server: ViteDevServer; root: Root }) => Promise<void>,
) {
  const window = new Window({ url });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    HTMLElement: window.HTMLElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    HTMLInputElement: window.HTMLInputElement,
    HTMLFormElement: window.HTMLFormElement,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    CSS: window.CSS,
    localStorage: window.localStorage,
    ResizeObserver: Observer,
    matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle.bind(window),
    innerWidth: 1280,
    innerHeight: 800,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div');
  document.body.append(mount);
  const root = createRoot(mount);
  try {
    if (url.includes('scenario=')) {
      const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
      await installScenario('settings-about-light');
    }
    await run({ server, root });
  } finally {
    await act(async () => root.unmount());
    await server.close();
    globalThis.fetch = originalFetch;
    await window.happyDOM.abort();
  }
}

test('StorageSettings separates lossless archiving from previewed permanent output cleanup', async () => {
  // Recurring bug class: persistence StorageSettings must not count deletable outputs as lossless archive candidates or delete them from Archive now.
  await withStorageUI(
    'http://localhost/?scenario=settings-about-light',
    async () => { throw new Error('Storage scenario contacted real Core'); },
    async ({ server, root }) => {
      const { default: StorageSettings } = await server.ssrLoadModule('/ui/components/StorageSettings.tsx');
      const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
      const { t } = await server.ssrLoadModule('/ui/i18n.ts');
      const page = within(document.body);

      await act(async () => {
        root.render(h(TooltipProvider, null, h(StorageSettings)));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });

      assert.ok(page.getByText(/52 to archive, 2 to compress/i));
      assert.ok(page.getByText(/Temporary outputs are deleted after 7 days/i));
      assert.ok(page.getByText(/Expired outputs \(>7d, deleted permanently\): 1/i));

      await act(async () => {
        fireEvent.click(page.getByRole('button', { name: t('storage.archiveNow'), exact: true }));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.ok(page.getByText(/24 archived to gzip, 2 metric log\(s\) compressed/i));

      await act(async () => {
        fireEvent.click(page.getByRole('button', { name: t('storage.previewCleanup'), exact: true }));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.ok(page.getByText(/Will permanently delete 0 expired archive\(s\), 1 expired output\(s\)/i));

      const outputsSwitch = page.getByRole('switch', { name: t('storage.includeOutputs', { days: 7 }), exact: true });
      assert.equal(outputsSwitch.getAttribute('aria-checked'), 'true');
      const confirmButton = page.getByRole('button', { name: t('storage.confirmPrune'), exact: true }) as HTMLButtonElement;
      assert.equal(confirmButton.disabled, false);

      await act(async () => {
        fireEvent.click(outputsSwitch);
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.equal(confirmButton.disabled, true);

      await act(async () => {
        fireEvent.click(outputsSwitch);
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.equal(confirmButton.disabled, false);
      await act(async () => {
        fireEvent.click(confirmButton);
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.ok(page.getByText(/Permanently deleted 0 archive\(s\), 1 output\(s\), 0 legacy file\(s\)/i));
    },
  );
});

test('StorageSettings disables Archive now when only expired outputs exist', async () => {
  // Recurring bug class: persistence expired outputs alone must keep Archive now disabled and route deletion only through Preview cleanup.
  const onlyExpiredOutputsStatus = {
    policy: { outputsMaxAgeDays: 7, archiveRetentionDays: 0 },
    hot: {
      receipts: { files: 0, bytes: 0, archivable: 0 },
      coordination: { files: 0, bytes: 0, archivable: 0, capacity: 8192 },
      dispatches: { files: 0, bytes: 0, archivable: 0 },
      changes: { files: 0, bytes: 0, archivable: 0 },
      notifications: { files: 0, bytes: 0, archivable: 0 },
      controlMetrics: { files: 0, bytes: 0, compressible: 0 },
      outputs: { files: 2, bytes: 2048, prunable: 1, prunableBytes: 1024 },
    },
    archives: { files: 1, bytes: 512 },
    legacy: { files: 0, bytes: 0, directories: {} },
    warnings: [],
  };
  await withStorageUI(
    'http://localhost/',
    async (input) => {
      const target = String(input);
      if (target.endsWith('/storage/status')) {
        return new Response(JSON.stringify(onlyExpiredOutputsStatus), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({
        applied: false,
        olderThanDays: 90,
        includeLegacy: true,
        includeOutputs: true,
        archives: { eligible: 0, removed: 0, bytes: 0 },
        outputs: { eligible: 1, removed: 0, bytes: 1024 },
        legacy: { directories: [], removed: 0, bytes: 0 },
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    async ({ server, root }) => {
      const { default: StorageSettings } = await server.ssrLoadModule('/ui/components/StorageSettings.tsx');
      const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
      const { t } = await server.ssrLoadModule('/ui/i18n.ts');
      const page = within(document.body);

      await act(async () => {
        root.render(h(TooltipProvider, null, h(StorageSettings)));
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });

      assert.ok(page.getByText(/0 to archive, 0 to compress/i));
      const archiveButton = page.getByRole('button', { name: t('storage.archiveNow'), exact: true }) as HTMLButtonElement;
      assert.equal(archiveButton.disabled, true);
      assert.ok(page.getByText(/Expired outputs \(>7d, deleted permanently\): 1/i));

      const cleanupButton = page.getByRole('button', { name: t('storage.previewCleanup'), exact: true }) as HTMLButtonElement;
      assert.equal(cleanupButton.disabled, false);
      await act(async () => {
        fireEvent.click(cleanupButton);
      });
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
      });
      assert.ok(page.getByText(/Will permanently delete 0 expired archive\(s\), 1 expired output\(s\)/i));
    },
  );
});
