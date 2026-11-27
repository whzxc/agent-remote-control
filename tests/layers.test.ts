import test from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h, useState } from 'react';
import { within, fireEvent, waitFor } from '@testing-library/dom';
import { assertNodeIdentity } from './helpers/dom-assert.ts';
import { withDialog } from './helpers/layers-ui.ts';
import { createLayerStore } from '../ui/state/layers.ts';

test('Close and Cancel retain busy work until completion and the dialog stays closed after late results', async () => {
  // Recurring bug class: lifecycle B1 header Close orphaned busy work and job-driven owners could reopen their dialog on completion.
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
  // Recurring bug class: lifecycle Setup > Add connection > Tool list requested a forbidden third dialog and could not edit its tools.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { installScenario } = await server.ssrLoadModule('/ui/scenarios.ts');
    await installScenario('p3-stacked-secure-en@light');
    const { SetupFlow } = await server.ssrLoadModule('/ui/components/ui/SetupFlow.tsx');
    const { default: AddConnection } = await server.ssrLoadModule('/ui/components/AddConnection.tsx');
    const { TooltipProvider } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    await act(async () => root.render(h(TooltipProvider, null,
      h(SetupFlow, { title: 'Source setup', steps: [], active: 0, onClose() {} }, h('input', { 'aria-label': 'Source draft', defaultValue: 'Parent retained' })),
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
  // Recurring bug class: lifecycle dialog scrims intercepted options, item-aligned Select dismissed its owner, and an undefined pointerEvents override blocked modal choices outside dialogs.
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
  // Recurring bug class: lifecycle independent workspace stores could retain an older panel, and capsule input bypassed dirty dismissal.
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
    const relayTrigger = page.getByRole('button', { name: 'Open Relay' });
    await act(async () => { relayTrigger.focus(); fireEvent.click(relayTrigger); });
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('layers.discardAction') }))); await settle();
    assert.ok(page.getByRole('dialog', { name: 'Relay' }));
    await act(async () => fireEvent.keyDown(page.getByRole('dialog', { name: 'Relay' }), { key: 'Escape' })); await settle();
    await waitFor(() => assertNodeIdentity(focused(), relayTrigger), { container: document.body });
    await act(async () => fireEvent.click(relayTrigger)); await settle();
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
  // Recurring bug class: lifecycle device pairing errors left the submitted code dirty and Escape could no longer close the finished attempt.
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

test('closing a dialog preserves focus when another action trigger is activated', async () => {
  // Recurring bug class: lifecycle close focus restoration stole focus from an already-focused recovery trigger.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Owner() {
      const [open, setOpen] = useState(false);
      return h('main', { tabIndex: -1 }, h(Button, { onClick: () => setOpen(true) }, 'Connections'), h(Button, null, 'Recover remote'),
        open && h(Dialog, { title: 'Connections', onClose: () => setOpen(false) }, 'Connection details'));
    }
    const page = within(document.body);
    await act(async () => root.render(h(Owner)));
    await act(async () => { const trigger = page.getByRole('button', { name: 'Connections', exact: true }); trigger.focus(); fireEvent.click(trigger); });
    await settle();
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true })));
    assert.equal(page.queryByRole('dialog', { name: 'Connections' }), null); await settle();
    const recovery = page.getByRole('button', { name: 'Recover remote' });
    await act(async () => recovery.focus());
    await settle();
    assertNodeIdentity(focused(), recovery);
  });
});

test('switching from Board to Task and back retains the originating panel detail and restores its control', async () => {
  // Recurring bug class: lifecycle switching away from Board ran its close callback again, clearing retained detail and Back focus target.
  await withDialog(async ({ server, root, settle, focused }) => {
    const { default: Panel } = await server.ssrLoadModule('/ui/components/ui/Panel.tsx');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { layers } = await server.ssrLoadModule('/ui/state/layers.ts');
    function Owner() {
      const [view, setView] = useState('board'), [record, setRecord] = useState(true);
      return h('main', null,
        view === 'board' && h(Panel, { key: 'board', title: 'Board', initialFocus: 'inspect-task', onClose: () => { setRecord(false); setView('closed'); } },
          record && h('section', { role: 'region', 'aria-label': 'Record details' }, h(Button, { id: 'inspect-task', onClick: () => layers.switchPanel(() => setView('task')) }, 'Inspect task'))),
        view === 'task' && h(Panel, { key: 'task', title: 'Task', onClose: () => setView('closed') }, h(Button, { onClick: () => layers.switchPanel(() => setView('board')) }, 'Back to Board')));
    }
    await act(async () => root.render(h(Owner))); await settle();
    const page = within(document.body);
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Inspect task' })));
    assert.ok(page.getByRole('dialog', { name: 'Task' }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Back to Board' }))); await settle();
    assert.ok(page.getByRole('region', { name: 'Record details' }));
    assertNodeIdentity(focused(), page.getByRole('button', { name: 'Inspect task' }));
  });
});

test('a third dialog request reports the stack limit instead of disappearing', () => {
  // Recurring bug class: lifecycle B1 silently ignored a third dialog request and left its trigger without a response.
  const store = createLayerStore();
  const request = (id: string) => ({ id, kind: 'dialog' as const, onClose() {} });
  store.open(request('parent'));
  store.open(request('child'));
  assert.throws(() => store.canOpen('dialog', 'third'), /at most two dialogs/);
  assert.throws(() => store.open(request('third')), /at most two dialogs/);
  assert.deepEqual(store.get().map(layer => layer.id), ['parent', 'child']);
});

test('closing a dialog with an unavailable opener restores the main landmark', async () => {
  // Recurring bug class: lifecycle removal of a trigger must leave keyboard focus on an exposed destination.
  await withDialog(async ({ root, server, settle, focused }) => {
    const { default: Dialog } = await server.ssrLoadModule('/ui/components/ui/Dialog.tsx');
    const { DialogFocusProvider } = await server.ssrLoadModule('/ui/components/kit/dialog-focus.ts');
    const { Button } = await server.ssrLoadModule('/ui/components/ui/index.tsx');
    const { t } = await server.ssrLoadModule('/ui/i18n.ts');
    function Owner() {
      const [open, setOpen] = useState(false), [disabled, setDisabled] = useState(false);
      return h(DialogFocusProvider, null,
        h('main', { tabIndex: -1 },
          h(Button, { disabled, onClick: () => { setOpen(true); setDisabled(true); } }, 'Unavailable opener'),
          open && h(Dialog, { title: 'Transient action', onClose: () => setOpen(false) }, 'Details')));
    }
    const page = within(document.body);
    await act(async () => root.render(h(Owner))); await settle();
    const opener = page.getByRole('button', { name: 'Unavailable opener' });
    await act(async () => { opener.focus(); fireEvent.click(opener); }); await settle();
    await act(async () => fireEvent.click(page.getByRole('button', { name: t('close'), exact: true }))); await settle();
    assertNodeIdentity(focused(), page.getByRole('main'));
  });
});
