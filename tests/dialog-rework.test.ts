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
        layerId: completion.layerId, title: 'Deployment', busy: job === 'running', onClose: () => setOpen(false),
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
      return dialog ? open && h(Dialog, { title: 'Agent account', onClose: () => setOpen(false) }, choices) : choices;
    }
    for (const position of ['popper', 'item-aligned'] as const) for (const host of ['none', 'single', 'stacked']) {
      await act(async () => root.render(h(TooltipProvider, null,
        host === 'stacked' && h(Dialog, { title: 'Setup', onClose() {} }, 'Parent retained'),
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


test('workspaces replace on open and capsule switching preserves dirty drafts until discard', async () => {
  // Regression: independent workspace stores could retain an older panel, and capsule input bypassed dirty dismissal.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Panel, usePanelState } = await server.ssrLoadModule('/ui/components/ui/Panel.tsx');
    const { layers } = await server.ssrLoadModule('/ui/state/layers.ts');
    const { Input, Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Editor() {
      const [draft, setDraft] = useState(''), [busy, setBusy] = useState(false);
      usePanelState({ dirty: !!draft, busy });
      return h('section', null,
        h(Input, { 'aria-label': 'Workspace draft', value: draft, onChange: (event: Event) => setDraft((event.target as HTMLInputElement).value) }),
        h(Button, { onClick: () => setBusy(value => !value) }, busy ? 'Finish work' : 'Start work'));
    }
    function CleanContributor() { usePanelState({}); return h('p', null, 'No pending edits'); }
    function Owner() {
      const [clean, setClean] = useState(false);
      const [workspace, setWorkspace] = useState<string | undefined>('Settings'), [board, setBoard] = useState(false);
      return h('main', null,
        h('nav', { 'data-workspace-switcher': true }, ...['Settings', 'Relay'].map(title => h(Button, {
          key: title, onClick: () => layers.switchPanel(() => setWorkspace(workspace === title ? undefined : title)),
        }, `Open ${title}`)), h(Button, { onClick: () => setBoard(true) }, 'Open Board')),
        workspace && h(Panel, { key: workspace, title: workspace, onClose: () => setWorkspace(undefined) }, h(Editor), h(Button, { onClick: () => setClean(true) }, 'Load another connector'), clean && h(CleanContributor)),
        board && h(Panel, { title: 'Board', onClose: () => setBoard(false) }, 'Board contents'));
    }
    const page = within(document.body);
    await act(async () => root.render(h(Owner))); await settle();
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Board' }))); await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Settings' }), null);
    assert.ok(page.getByRole('dialog', { name: 'Board' }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Settings' }))); await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Board' }), null);
    const draft = page.getByRole('textbox', { name: 'Workspace draft' });
    await act(async () => fireEvent.change(draft, { target: { value: 'Retained draft' } }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Load another connector' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Relay' }))); await settle();
    const keep = page.getByRole('button', { name: t('layers.keepEditing') });
    assertNodeIdentity(focused(), keep);
    assert.equal(page.queryByRole('dialog', { name: 'Relay' }), null);
    await act(async () => fireEvent.click(keep));
    assert.equal((page.getByRole('textbox', { name: 'Workspace draft' }) as HTMLInputElement).value, 'Retained draft');
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Relay' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('layers.discardAction') }))); await settle();
    assert.ok(page.getByRole('dialog', { name: 'Relay' }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Start work' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Settings' }))); await settle();
    assertNodeIdentity(focused(), page.getByRole('button', { name: t('layers.keepOpen') }));
    assert.equal(page.queryByRole('dialog', { name: 'Settings' }), null);
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('layers.keepOpen') })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Finish work' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Settings' }))); await settle();
    assert.ok(page.getByRole('dialog', { name: 'Settings' }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open Settings' }))); await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Settings' }), null);
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
        title: 'Pair device', dirty: draft.dirty, busy, onClose: () => setOpen(false),
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
          open && h(Dialog, { title: 'Connections', onClose: () => setOpen(false) }, 'Connection details'));
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

test('node switchers replace clean panels, protect edits and toggle their own panel closed', async () => {
  // Regression: graph-node outside-click exceptions bypassed dirty dismissal and node selection could leave two panels open.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Panel, usePanelState } = await server.ssrLoadModule('/ui/components/ui/Panel.tsx');
    const { default: GraphNode } = await server.ssrLoadModule('/ui/components/GraphNode.tsx');
    const { layers } = await server.ssrLoadModule('/ui/state/layers.ts');
    const { Input, Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Draft() {
      const [value, setValue] = useState(''); usePanelState({ dirty: !!value });
      return h(Input, { 'aria-label': 'Node draft', value, onChange: (event: Event) => setValue((event.target as HTMLInputElement).value) });
    }
    function Owner() {
      const [selected, setSelected] = useState<string | undefined>('Workspace');
      return h('main', null, ...['Source', 'Agent'].map(id => h(GraphNode, { key: id, label: id, state: 'normal',
        hideLabel: selected === id, panelExpanded: selected === id, caption: `${id} caption`,
        onOpen: () => { const next = selected === id ? undefined : id; layers.switchPanel(() => setSelected(next)); },
      }, id === 'Source' ? 'S' : 'A')), selected && h(Panel, { key: selected,
        side: selected === 'Source' ? 'left' : selected === 'Agent' ? 'right' : 'center', title: `${selected} editor`, onClose: () => setSelected(undefined),
      }, h(Draft), h(Button, { onClick: () => setSelected(undefined) }, 'Finish')));
    }
    const page = within(document.body);
    await act(async () => root.render(h(Owner))); await settle();
    const open = async (name: string) => { await act(async () => fireEvent.click(page.getByRole('button', { name, exact: true }))); await settle(); };
    await open('Source');
    assert.equal(page.queryByRole('dialog', { name: 'Workspace editor' }), null);
    assert.ok(page.getByRole('dialog', { name: 'Source editor' }));
    assert.ok(page.getByRole('button', { name: 'Source', exact: true, expanded: true }));
    await act(async () => fireEvent.change(page.getByRole('textbox', { name: 'Node draft' }), { target: { value: 'Unsaved node input' } }));
    await open('Agent');
    assertNodeIdentity(focused(), page.getByRole('button', { name: t('layers.keepEditing') }));
    await open(t('layers.keepEditing'));
    assert.equal((page.getByRole('textbox', { name: 'Node draft' }) as HTMLInputElement).value, 'Unsaved node input');
    await open('Agent'); await open(t('layers.discardAction'));
    assert.ok(page.getByRole('dialog', { name: 'Agent editor' }));
    assert.equal(page.queryByRole('dialog', { name: 'Source editor' }), null);
    await open('Agent');
    assert.equal(page.queryByRole('dialog'), null);
    assert.ok(page.getByRole('button', { name: 'Agent', exact: true, expanded: false }));
  });
});


test('external navigation waits as attention while a modal draft remains open', async () => {
  // Regression: external tray and deep-link navigation replaced surfaces behind an active dialog.
  await withDialog(async ({ server, root, settle }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    const { requestExternalNavigation, navigationAttention, openNavigationAttention } = await server.ssrLoadModule('/ui/state/externalNavigation.ts');
    function Owner() {
      const [open, setOpen] = useState(true), [target] = useState('Original');
      const attention = navigationAttention.use();
      return h('main', null, h('p', { role: 'status' }, target),
        attention.map((item: { title: string }) => h(Button, { key: item.title, onClick: () => openNavigationAttention(item.title) }, item.title)),
        open && h(Dialog, { title: 'Draft', onClose: () => setOpen(false) }, h('input', { 'aria-label': 'Name', defaultValue: 'Unsaved' })));
    }
    await act(async () => root.render(h(Owner))); await settle();
    await act(async () => requestExternalNavigation('Settings', () => root.render(h('p', { role: 'status' }, 'Settings opened'))));
    const page = within(document.body);
    assert.ok(page.getByRole('dialog', { name: 'Draft' }));
    assert.equal((page.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value, 'Unsaved');
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true })));
    await settle();
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Settings', exact: true })));
    assert.ok(page.getByRole('status').textContent?.includes('Settings opened'));
  });
});


test('action feedback stays in the open owner and late results use global feedback', async () => {
  // Regression: Settings and relay action results appeared as global toasts while their initiating layer was still open.
  await withDialog(async ({ server, root, settle }) => {
    const { default: Dialog, useDialogFeedback } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { connector } = await server.ssrLoadModule('/ui/state/connector.ts');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    let report = (_message: string, _error = false) => {};
    function Action() { report = useDialogFeedback(); return h(Button, { onClick: () => report('Saved inside') }, 'Save'); }
    function Owner() {
      const [open, setOpen] = useState(true), { feedback } = connector.use();
      return h('main', null, feedback.text && h('p', { role: 'status' }, feedback.text), open && h(Dialog, { title: 'Editor', onClose: () => setOpen(false) }, h(Action)));
    }
    await act(async () => root.render(h(Owner))); await settle();
    const page = within(document.body);
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Save', exact: true })));
    assert.equal(within(page.getByRole('dialog', { name: 'Editor' })).getByRole('status').textContent, 'Saved inside');
    assert.equal(page.getAllByRole('status').length, 1);
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true }))); await settle();
    await act(async () => report('Background failure', true));
    assert.equal(page.getByRole('status').textContent, 'Background failure');
  });
});
