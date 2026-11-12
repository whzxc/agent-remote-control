import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer, type ViteDevServer } from 'vite';
import { act, createElement as h, useState } from 'react';
import type { Root } from 'react-dom/client';
import { within, fireEvent } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';

async function withDialog(run: (context: { server: ViteDevServer; root: Root; settle: () => Promise<void>; focused: () => Node | null }) => Promise<void>) {
  const window = new Window({ url: 'http://localhost/?scenario=p3-stacked-secure-en-light' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, location: window.location, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter,
    HTMLInputElement: window.HTMLInputElement, HTMLFormElement: window.HTMLFormElement, HTMLSelectElement: window.HTMLSelectElement,
    DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
    Event: window.Event, CustomEvent: window.CustomEvent, CSS: window.CSS, DOMRect: window.DOMRect,
    innerWidth: 1280, innerHeight: 800, ResizeObserver: Observer, matchMedia: window.matchMedia,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true,
  });
  let focused: Node | null = null;
  document.addEventListener('focusin', event => { focused = event.target as Node; });
  const server = await createServer({ configFile: false, server: { middlewareMode: true, watch: null, ws: false } });
  const { createRoot } = await import('react-dom/client');
  const mount = document.createElement('div'); document.body.append(mount); const root = createRoot(mount);
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  try { await run({ server, root, settle, focused: () => focused }); }
  finally { await act(async () => root.unmount()); await server.close(); await window.happyDOM.close(); }
}

test('Close and Cancel retain busy work until completion and the dialog stays closed after late results', async () => {
  // Regression: B1 header Close orphaned busy work and job-driven owners could reopen their dialog on completion.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Dialog, DialogClose, useDialogCompletion } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    let finishWork = () => {}, lateResult = () => {};
    function Owner() {
      const [open, setOpen] = useState(true), [job, setJob] = useState('idle');
      const completion = useDialogCompletion(() => setOpen(false));
      lateResult = () => setJob('late result');
      const start = async () => {
        setJob('running');
        await new Promise<void>(resolve => { finishWork = resolve; });
        setJob('finished'); await completion.finish();
      };
      return h('main', null, h('p', { role: 'status' }, job), open && h(Dialog, {
        layerId: completion.layerId, size: 's', title: 'Deployment', busy: job === 'running', onClose: () => setOpen(false),
        footer: h(DialogClose, { asChild: true }, h(Button, null, t('cancel'))),
      }, h(Button, { onClick: () => void start() }, 'Start')));
    }
    await act(async () => root.render(h(Owner))); await settle();
    const page = within(document.body);
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Start' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('cancel'), exact: true })));
    assertNodeIdentity(focused(), page.getByRole('button', { name: t('layers.keepOpen') }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('layers.keepOpen') })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true })));
    assertNodeIdentity(focused(), page.getByRole('button', { name: t('layers.keepOpen') }));
    assert.ok(page.getByRole('dialog', { name: 'Deployment' }));
    await act(async () => finishWork()); await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Deployment' }), null);
    await act(async () => lateResult()); await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Deployment' }), null);
    assert.ok(page.getByText('late result'));
  });
});

test('stacked setup edits tools inside its owning dialog and Back and Escape preserve the draft and focus', async () => {
  // Regression: Setup > Add connection > Tool list requested a forbidden third dialog and could not edit its tools.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('p3-stacked-secure-en-light');
    const { default: SetupDialog } = await server.ssrLoadModule('/ui/components/SetupDialog.tsx');
    const { default: AddConnection } = await server.ssrLoadModule('/ui/components/AddConnection.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    await act(async () => root.render(h(TooltipProvider, null,
      h(SetupDialog, { title: 'Source setup', steps: [], active: 0, onClose() {} }, h('input', { 'aria-label': 'Source draft', defaultValue: 'Parent retained' })),
      h(AddConnection, { options: { forSource: true, method: 'https', step: 'address' }, onClose() {}, onAdded() {} }))));
    await settle();
    const page = within(document.body);
    const name = page.getByRole('textbox', { name: t('setup.connectionName') });
    await act(async () => fireEvent.input(name, { target: { value: 'Draft connection' } }));
    const custom = page.getByRole('radio', { name: t('toolsCustom'), exact: true });
    await act(async () => { custom.focus(); fireEvent.click(custom); }); await settle();
    assert.equal(page.getAllByRole('dialog', { hidden: true }).length, 2);
    assert.ok(page.getByRole('dialog', { name: (name: string) => name.includes(t('toolList')) }));
    const toolName = /act · task_mark_read/;
    await act(async () => fireEvent.click(page.getByRole('checkbox', { name: toolName })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('back'), exact: true }))); await settle();
    assertNodeIdentity(focused(), custom);
    assert.equal((page.getByRole('textbox', { name: t('setup.connectionName') }) as HTMLInputElement).value, 'Draft connection');
    await act(async () => { custom.focus(); fireEvent.click(custom); }); await settle();
    assert.equal(page.getByRole('checkbox', { name: toolName }).getAttribute('aria-checked'), 'false');
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: (name: string) => name.includes(t('toolList')) }), { key: 'Escape' })); await settle();
    assertNodeIdentity(focused(), custom);
    assert.ok(page.getByRole('textbox', { name: t('setup.connectionName') }));
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: t('source.newConnection'), exact: true }), { key: 'Escape' }));
    assert.ok(page.getByRole('button', { name: t('layers.keepEditing') }));
  });
});
