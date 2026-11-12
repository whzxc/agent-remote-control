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

test('choosing a modal SingleChoice option applies it outside dialogs and retains its dialog owner in either position', async () => {
  // Regression: dialog scrims intercepted options, item-aligned Select dismissed its owner, and an undefined pointerEvents override blocked modal choices outside dialogs.
  await withDialog(async ({ server, root, settle }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { SingleChoice, TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const page = within(document.body);
    function Profile({ position, dialog }: { position: 'popper' | 'item-aligned'; dialog: boolean }) {
      const [open, setOpen] = useState(true), [profile, setProfile] = useState('default');
      const choices = h('section', null,
        h(SingleChoice, { dropdown: true, position, label: 'Browser profile', value: profile, onChange: setProfile,
          options: [{ value: 'default', label: 'Default browser' }, { value: 'chrome-profile-a', label: 'Google Chrome · Profile A' }] }),
        h('output', { 'aria-label': 'Selected profile' }, profile));
      return dialog ? open && h(Dialog, { size: 'm', title: 'Agent account', onClose: () => setOpen(false) }, choices) : choices;
    }
    for (const position of ['popper', 'item-aligned'] as const) for (const host of ['none', 'single', 'stacked']) {
      await act(async () => root.render(h(TooltipProvider, null,
        host === 'stacked' && h(Dialog, { size: 'm', title: 'Setup', onClose() {} }, 'Parent retained'),
        h(Profile, { position, dialog: host !== 'none' }))));
      await settle();
      await act(async () => fireEvent.keyDown(page.getByRole('combobox', { name: 'Browser profile' }), { key: 'Enter' }));
      await settle();
      const option = page.getByRole('option', { name: 'Google Chrome · Profile A', exact: true });
      await act(async () => {
        fireEvent.pointerMove(option, { pointerType: 'mouse' });
        fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' });
        fireEvent.pointerUp(option, { button: 0, pointerType: 'mouse' });
        fireEvent.click(option);
      });
      await settle();
      if (host !== 'none') assert.ok(page.getByRole('dialog', { name: 'Agent account' }));
      assert.equal(page.getByRole('status', { name: 'Selected profile' }).textContent, 'chrome-profile-a');
      assert.equal(page.getByRole('combobox', { name: 'Browser profile' }).getAttribute('aria-expanded'), 'false');
      await act(async () => root.render(null)); await settle();
    }
  });
});

test('a finished submitted attempt is clean until the user edits the value again', async () => {
  // Regression: device pairing errors left the submitted code dirty and Escape could no longer close the finished attempt.
  await withDialog(async ({ server, root, settle }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { useSubmittedDirty } = await server.ssrLoadModule('/ui/components/ui/useSubmittedDirty.ts');
    const { Input, Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    let finish = () => {};
    function Owner() {
      const [open, setOpen] = useState(true), [value, setValue] = useState(''), [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
      const draft = useSubmittedDirty(value, !!value);
      const submit = async () => {
        draft.submit(); setBusy(true);
        await new Promise<void>(resolve => { finish = resolve; });
        setFailed(true); setBusy(false);
      };
      return h('main', null, h(Button, { onClick: () => setOpen(true) }, 'Open form'), open && h(Dialog, {
        size: 'm', title: 'Pair device', dirty: draft.dirty, busy, onClose: () => setOpen(false),
      }, h(Input, { 'aria-label': 'Pairing code', value, onChange: (event: Event) => setValue((event.target as HTMLInputElement).value) }),
      failed && h('p', { role: 'alert' }, 'Pairing failed'), h(Button, { onClick: () => void submit() }, 'Pair')));
    }
    const page = within(document.body);
    await act(async () => root.render(h(Owner))); await settle();
    await act(async () => fireEvent.change(page.getByRole('textbox', { name: 'Pairing code' }), { target: { value: 'Submitted code' } }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Pair', exact: true })));
    await act(async () => finish()); await settle();
    assert.ok(page.getByRole('alert'));
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: 'Pair device' }), { key: 'Escape' })); await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Pair device' }), null);
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open form' }))); await settle();
    await act(async () => fireEvent.change(page.getByRole('textbox', { name: 'Pairing code' }), { target: { value: 'Edited after result' } }));
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: 'Pair device' }), { key: 'Escape' })); await settle();
    assert.ok(page.getByRole('button', { name: t('layers.keepEditing') }));
  });
});

test('deferred close focus restoration preserves the next action trigger', async () => {
  // Regression: studio-connections at 640px reopened Connections when deferred restoration stole the recovery trigger before Enter.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const originalFrame = globalThis.requestAnimationFrame, originalCancel = globalThis.cancelAnimationFrame;
    const frames: FrameRequestCallback[] = [];
    globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
    globalThis.cancelAnimationFrame = () => {};
    try {
      function Owner() {
        const [open, setOpen] = useState(false);
        return h('main', null, h(Button, { onClick: () => setOpen(true) }, 'Connections'), h(Button, null, 'Recover remote'),
          open && h(Dialog, { size: 'm', title: 'Connections', onClose: () => setOpen(false) }, 'Connection details'));
      }
      const page = within(document.body);
      await act(async () => root.render(h(Owner)));
      await act(async () => { const trigger = page.getByRole('button', { name: 'Connections', exact: true }); trigger.focus(); fireEvent.click(trigger); });
      await act(async () => { for (const frame of frames.splice(0)) frame(0); });
      await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true })));
      assert.equal(page.queryByRole('dialog', { name: 'Connections' }), null); await settle();
      const recovery = page.getByRole('button', { name: 'Recover remote' });
      await act(async () => recovery.focus());
      await act(async () => { for (const frame of frames.splice(0)) frame(0); }); await settle();
      assertNodeIdentity(focused(), recovery);
    } finally { globalThis.requestAnimationFrame = originalFrame; globalThis.cancelAnimationFrame = originalCancel; }
  });
});
