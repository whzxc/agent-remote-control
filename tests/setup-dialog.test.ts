import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { createServer } from 'vite';
import { act, createElement as h, useState } from 'react';
import { within, fireEvent } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';

test('dialogs retain parent input, gate outside dismissal and honor pending-close withdrawal', async () => {
  // Regression: stacked setup hid its child from assistive technology; outside dismissal leaked clicks and running-work footers lacked Keep open.
  const window = new Window({ url: 'http://localhost' });
  const media = Object.assign(new window.EventTarget(), { matches: true });
  window.matchMedia = () => media as unknown as MediaQueryList;
  class Observer { observe() {} unobserve() {} disconnect() {} }
  Object.assign(globalThis, {
    window, document: window.document, localStorage: window.localStorage,
    HTMLElement: window.HTMLElement, Element: window.Element, Node: window.Node, NodeFilter: window.NodeFilter,
    HTMLInputElement: window.HTMLInputElement, DocumentFragment: window.DocumentFragment, MutationObserver: window.MutationObserver,
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
  try {
    const { default: SetupDialog } = await server.ssrLoadModule('/ui/components/SetupDialog.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { default: Dialog, DialogActions, useDialogCompletion } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    function Setup() {
      const [child, setChild] = useState(true);
      return h('main', null,
        h('button', null, 'Background action'),
        h(SetupDialog, { title: 'Parent setup', active: 0, steps: [], onClose() {} },
          h('input', { 'aria-label': 'Source name', defaultValue: 'Saved source' }),
          h('button', { onClick: () => setChild(true) }, 'Add connection')),
        child && h(SetupDialog, { title: 'Child connection', parentTitle: 'Parent setup', stacked: true, active: 0,
          steps: [], onClose: () => setChild(false) },
          h('input', { 'aria-label': 'Connection address' })));
    }
    const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    const page = within(document.body);
    await act(async () => root.render(h(Setup))); await settle();
    for (let opening = 0; opening < 2; opening++) {
      const child = page.getByRole('dialog', { name: 'Child connection' });
      assert.equal(page.getAllByRole('dialog').length, 1);
      assert.equal(page.queryByRole('button', { name: 'Background action' }), null);
      assert.equal(page.queryByRole('textbox', { name: 'Source name' }), null);
      assertNodeIdentity(focused, child);
      await act(async () => fireEvent.click(within(child).getByRole('button', { name: t('close') })));
      await settle();
      const parent = page.getByRole('dialog', { name: 'Parent setup' });
      assert.equal(page.getAllByRole('dialog').length, 1);
      assertNodeIdentity(focused, opening ? within(parent).getByRole('button', { name: 'Add connection' }) : parent);
      assert.equal((page.getByRole('textbox', { name: 'Source name' }) as HTMLInputElement).value, 'Saved source');
      if (!opening) {
        const trigger = within(parent).getByRole('button', { name: 'Add connection' });
        await act(async () => { trigger.focus(); fireEvent.click(trigger); }); await settle();
      }
    }
    let finishWork: () => void = () => {};
    function Editor() {
      const [open, setOpen] = useState(false), [value, setValue] = useState('');
      const [busy, setBusy] = useState(false), [cancellable, setCancellable] = useState(false);
      const [background, setBackground] = useState(false);
      const completion = useDialogCompletion(() => setOpen(false));
      const save = async () => {
        setBusy(true);
        await new Promise<void>(resolve => { finishWork = resolve; });
        setValue('');
        await completion.finish();
        setBusy(false);
      };
      return h('main', null,
        h('button', { onClick: () => setOpen(true) }, 'Open editor'),
        h('button', { onClick: () => setBackground(true) }, 'Background action'),
        h('p', { role: 'status' }, background ? 'Background activated' : 'Background idle'),
        open && h(Dialog, { layerId: completion.layerId, title: 'Editor', size: 's', dirty: !!value, busy,
          onClose: () => setOpen(false), onCancel: cancellable ? () => { finishWork(); } : undefined },
          h('form', { onSubmit: (event: Event) => { event.preventDefault(); void save(); } },
            h('input', { 'aria-label': 'Name', value, onChange: (event: { target: HTMLInputElement }) => setValue(event.target.value) }),
            h('label', null, h('input', { type: 'checkbox', checked: cancellable,
              onChange: (event: { target: HTMLInputElement }) => setCancellable(event.target.checked) }), 'Cancellable'),
            h(DialogActions, null, h(Button, { type: 'submit', busy }, 'Save')))));
    }
    await act(async () => root.render(h(Editor))); await settle();
    const background = page.getByRole('button', { name: 'Background action' });
    const openEditor = async () => {
      const trigger = page.getByRole('button', { name: 'Open editor' });
      await act(async () => { trigger.focus(); fireEvent.click(trigger); }); await settle();
    };
    const outside = async () => {
      await act(async () => {
        fireEvent.pointerDown(background, { button: 0, pointerType: 'mouse' });
        fireEvent.pointerUp(background, { button: 0 });
        fireEvent.click(background);
      });
      await settle();
    };
    await openEditor(); await outside();
    await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Editor' }), null);
    assert.ok(page.getByText('Background idle'));
    await openEditor();
    await act(async () => fireEvent.input(page.getByRole('textbox', { name: 'Name' }), { target: { value: 'Draft' } }));
    await outside();
    const keepEditing = page.getByRole('button', { name: t('layers.keepEditing') });
    assertNodeIdentity(focused, keepEditing);
    await act(async () => fireEvent.click(keepEditing));
    assert.equal((page.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value, 'Draft');
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true })));
    await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Editor' }), null);
    await openEditor();
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Save', exact: true })));
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: 'Editor' }), { key: 'Escape' }));
    const keepOpen = page.getByRole('button', { name: t('layers.keepOpen') });
    assertNodeIdentity(focused, keepOpen);
    assertNodeIdentity(page.queryByRole('button', { name: t('layers.stopClose') }), null);
    await act(async () => fireEvent.click(keepOpen));
    await act(async () => finishWork()); await settle();
    assert.ok(page.getByRole('dialog', { name: 'Editor' }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Save', exact: true })));
    await outside();
    await act(async () => finishWork()); await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Editor' }), null);
    await openEditor();
    await act(async () => fireEvent.click(page.getByRole('checkbox', { name: 'Cancellable' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Save', exact: true })));
    await outside();
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('layers.stopClose') })));
    await settle();
    assertNodeIdentity(page.queryByRole('dialog', { name: 'Editor' }), null);
  } finally {
    await act(async () => root.unmount()); await server.close(); await window.happyDOM.close();
  }
});
