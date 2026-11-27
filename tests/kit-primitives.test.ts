import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { act, createElement as h, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { within, fireEvent } from '@testing-library/dom';
import { Window } from 'happy-dom';
import { createServer, type ViteDevServer } from 'vite';
import type { Root } from 'react-dom/client';
import { assertNodeIdentity } from './helpers/dom-assert.ts';
import en from '../ui/locales/en.json' with { type: 'json' };
import zhCN from '../ui/locales/zh-CN.json' with { type: 'json' };

const uiRoot = path.resolve('ui');

async function createKitServer(isolateBaseUi = false): Promise<ViteDevServer> {
  return createServer({
    configFile: false,
    resolve: { alias: { '@': uiRoot } },
    ssr: isolateBaseUi ? { noExternal: ['@base-ui/react', '@base-ui/utils'] } : undefined,
    server: { middlewareMode: true, watch: null, ws: false },
  });
}

async function withKitDom(
  run: (context: {
    server: ViteDevServer;
    root: Root;
    settle: () => Promise<void>;
    focused: () => Node | null;
  }) => Promise<void>,
) {
  const dom = new Window({ url: 'http://localhost/' });
  dom.document.documentElement.setAttribute('data-arc-browser', '');
  const media = Object.assign(new dom.EventTarget(), { matches: true });
  dom.matchMedia = () => media as unknown as MediaQueryList;
  class Observer {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  const globals: Record<string, unknown> = {
    window: dom,
    document: dom.document,
    location: dom.location,
    localStorage: dom.localStorage,
    HTMLElement: dom.HTMLElement,
    SVGElement: dom.SVGElement,
    Element: dom.Element,
    Node: dom.Node,
    NodeFilter: dom.NodeFilter,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLButtonElement: dom.HTMLButtonElement,
    HTMLFormElement: dom.HTMLFormElement,
    HTMLSelectElement: dom.HTMLSelectElement,
    DocumentFragment: dom.DocumentFragment,
    MutationObserver: dom.MutationObserver,
    Event: dom.Event,
    CustomEvent: dom.CustomEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
    KeyboardEvent: dom.KeyboardEvent,
    FocusEvent: dom.FocusEvent,
    CSS: dom.CSS,
    DOMRect: dom.DOMRect,
    innerWidth: 1280,
    innerHeight: 800,
    ResizeObserver: Observer,
    IntersectionObserver: Observer,
    matchMedia: dom.matchMedia,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: (callback: FrameRequestCallback) =>
      setTimeout(() => callback(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
    IS_REACT_ACT_ENVIRONMENT: true,
  };

  const target = globalThis as Record<string, unknown>;
  const previous = new Map<string, { had: boolean; value: unknown }>();
  for (const [key, value] of Object.entries(globals)) {
    previous.set(key, { had: Object.prototype.hasOwnProperty.call(target, key), value: target[key] });
    target[key] = value;
  }

  let focused: Node | null = null;
  dom.document.addEventListener('focusin', (event) => {
    focused = event.target as Node;
  });

  const server = await createKitServer();
  const { createRoot } = await import('react-dom/client');
  const mount = dom.document.createElement('div');
  dom.document.body.append(mount);
  const root = createRoot(mount);
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
    });

  try {
    await run({ server, root, settle, focused: () => focused });
  } finally {
    await act(async () => root.unmount());
    await server.close();
    await dom.happyDOM.close();
    for (const [key, entry] of previous.entries()) {
      if (entry.had) target[key] = entry.value;
      else delete target[key];
    }
  }
}

test('i18n core, LocaleProvider, and static kit surfaces render in SSR without DOM globals', async () => {
  // Contract: ADG React kit compilation executes in Node SSR without window or document globals.
  const target = globalThis as Record<string, unknown>;
  assert.equal(typeof target.window, 'undefined');
  assert.equal(typeof target.document, 'undefined');

  const server = await createKitServer(true);
  try {
    const core = await server.ssrLoadModule('/ui/i18n/core.ts');
    const reactI18n = await server.ssrLoadModule('/ui/i18n/react.tsx');
    const kit = await server.ssrLoadModule('/ui/components/kit/index.ts');

    try {
      assert.equal(core.resolveLocale(['zh-Hans-CN', 'en-US']), 'zh-CN');
      assert.equal(core.resolveLocale(['fr-FR', 'en-GB']), 'en');

      core.setSsrLocale('zh-CN');
      assert.equal(core.t('close'), zhCN.close);

      core.setSsrLocale('en');
      assert.equal(core.t('close'), en.close);

      core.setSsrLocale(null);
      assert.equal(core.getActiveLocale(), 'en');

      const secret = 'sk-arc-live-9876543210';
      const markup = renderToStaticMarkup(
        h(
          reactI18n.LocaleProvider,
          { locale: 'zh-CN' },
          h(
            kit.PrivacyProvider,
            { hidden: true, values: [secret] },
            h(
              kit.DialogSurface,
              { title: 'Connector details', footer: h(kit.Button, null, 'Done') },
              h(kit.SensitiveText, null, secret),
              h(kit.Alert, { tone: 'warning' }, `Token ${secret}`),
            ),
            h(
              kit.WorkspaceShellSurface,
              { title: 'Settings', onClose: () => {}, onToggleExpand: () => {} },
              h(kit.Badge, { tone: 'success' }, 'Ready'),
            ),
            h(
              kit.InspectorSheetSurface,
              { title: 'Relay node', meta: 'Connected', onClose: () => {} },
              h(kit.Empty, { title: 'No recent calls' }),
            ),
          ),
        ),
      );

      assert.ok(markup.includes(`aria-label="${zhCN.close}"`));
      assert.ok(markup.includes(`aria-label="${zhCN.expandPanelWidth}"`));
      assert.ok(markup.includes(`aria-label="${zhCN['accounts.hidden']}"`));
      assert.ok(markup.includes('data-slot="dialog-surface"'));
      assert.ok(markup.includes('data-slot="workspace-shell"'));
      assert.ok(markup.includes('data-slot="inspector-sheet"'));
      assert.equal(markup.includes(secret), false);
    } finally {
      core.setSsrLocale(null);
    }
  } finally {
    await server.close();
  }
});

test('useDismissalGuard and DismissalFooter guard dirty drafts, running work, and late completions', async () => {
  // Recurring bug class: lifecycle closing a dirty or busy layer must focus the safe recovery action and honor keep-open vs auto-close on completion.
  await withKitDom(async ({ server, root, settle, focused }) => {
    const kit = await server.ssrLoadModule('/ui/components/kit/index.ts');
    const outcomes: Array<{ closed: boolean }> = [];
    let allowCancel = false;
    let cancelled = 0;

    function GuardHarness() {
      const [open, setOpen] = useState(true);
      const [draft, setDraft] = useState('');
      const [busy, setBusy] = useState(false);
      const [cancellable, setCancellable] = useState(false);
      const submitted = kit.useSubmittedDirty(draft, Boolean(draft));
      const guard = kit.useDismissalGuard({
        dirty: submitted.dirty,
        busy,
        onClose: () => setOpen(false),
        onCancel: cancellable
          ? () => {
              if (!allowCancel) return false;
              cancelled += 1;
              setBusy(false);
              return true;
            }
          : undefined,
        onLateComplete: (outcome: { closed: boolean }) => outcomes.push(outcome),
      });

      return h(
        'main',
        null,
        h(kit.Button, { onClick: () => setOpen(true) }, 'Reopen'),
        h(kit.Button, { onClick: () => setBusy(true) }, 'Start busy'),
        h(kit.Button, { onClick: () => setBusy(false) }, 'Finish busy'),
        h(kit.Button, { onClick: () => setCancellable((value) => !value) }, 'Toggle cancellable'),
        open &&
          h(
            'section',
            { role: 'dialog', 'aria-label': 'Guarded form' },
            h(kit.Input, {
              'aria-label': 'Draft field',
              value: draft,
              onChange: (event: Event) => setDraft((event.target as HTMLInputElement).value),
            }),
            h(
              kit.Button,
              {
                onClick: () => {
                  submitted.submit();
                  setBusy(true);
                },
              },
              'Submit draft',
            ),
            h(kit.Button, { onClick: () => guard.requestClose() }, 'Ambient dismiss'),
            h(kit.Button, { onClick: () => guard.requestClose({ explicit: true }) }, 'Explicit cancel'),
            h(kit.DismissalFooter, {
              status: guard.status,
              cancellable: guard.cancellable,
              onDiscard: guard.confirmDiscard,
              onStopAndClose: guard.stopAndClose,
              onKeepOpen: guard.keepOpen,
            }),
          ),
      );
    }

    const page = within(document.body);
    await act(async () => root.render(h(GuardHarness)));
    await settle();

    // Dirty ambient dismiss opens discard footer and focuses Keep editing.
    await act(async () =>
      fireEvent.change(page.getByRole('textbox', { name: 'Draft field' }), {
        target: { value: 'Unsaved token' },
      }),
    );
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    const keepEditing = page.getByRole('button', { name: en['layers.keepEditing'] });
    assertNodeIdentity(focused(), keepEditing);
    assert.ok(page.getByRole('dialog', { name: 'Guarded form' }));

    // Keep editing retains draft and clears the confirmation footer.
    await act(async () => fireEvent.click(keepEditing));
    assert.equal(page.queryByRole('button', { name: en['layers.keepEditing'] }), null);
    assert.equal(
      (page.getByRole('textbox', { name: 'Draft field' }) as HTMLInputElement).value,
      'Unsaved token',
    );

    // Explicit cancel closes a dirty (non-busy) layer immediately.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Explicit cancel' })));
    assert.equal(page.queryByRole('dialog', { name: 'Guarded form' }), null);

    // Reopen and verify Discard closes on ambient dismiss.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Reopen' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    await act(async () =>
      fireEvent.click(page.getByRole('button', { name: en['layers.discardAction'] })),
    );
    assert.equal(page.queryByRole('dialog', { name: 'Guarded form' }), null);

    // Reopen, submit draft (marks baseline & busy): explicit cancel must still guard running work.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Reopen' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Submit draft' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Explicit cancel' })));
    const keepOpen = page.getByRole('button', { name: en['layers.keepOpen'] });
    assertNodeIdentity(focused(), keepOpen);

    // Choosing Keep open retains the dialog when work completes and reports { closed: false }.
    await act(async () => fireEvent.click(keepOpen));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Finish busy' })));
    await settle();
    assert.ok(page.getByRole('dialog', { name: 'Guarded form' }));
    assert.deepEqual(outcomes, [{ closed: false }]);

    // After submission with no subsequent edit, useSubmittedDirty reports clean so ambient dismiss closes directly.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    assert.equal(page.queryByRole('dialog', { name: 'Guarded form' }), null);

    // Reopen, run busy work, request close without clicking Keep open -> auto-closes when work finishes.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Reopen' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Start busy' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    assert.ok(page.getByRole('button', { name: en['layers.keepOpen'] }));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Finish busy' })));
    await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Guarded form' }), null);
    assert.deepEqual(outcomes, [{ closed: false }, { closed: true }]);

    // Cancellable busy work honors onCancel returning false vs true.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Toggle cancellable' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Reopen' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Start busy' })));
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    await act(async () =>
      fireEvent.click(page.getByRole('button', { name: en['layers.stopClose'] })),
    );
    await settle();
    assert.ok(page.getByRole('dialog', { name: 'Guarded form' }));
    assert.equal(cancelled, 0);

    allowCancel = true;
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Ambient dismiss' })));
    await act(async () =>
      fireEvent.click(page.getByRole('button', { name: en['layers.stopClose'] })),
    );
    await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Guarded form' }), null);
    assert.equal(cancelled, 1);

    // Backwards-compatible ui/i18n.ts facade remains wired to the runtime language store.
    const i18nFacade = await server.ssrLoadModule('/ui/i18n.ts');
    i18nFacade.setLanguage('zh-CN');
    assert.equal(i18nFacade.t('close'), zhCN.close);
    i18nFacade.setLanguage('en');
    assert.equal(i18nFacade.t('close'), en.close);
  });
});

test('Base UI Dialog supports Select popups and nested Dialogs without dismissing parent shells', async () => {
  // Contract: native Base UI portal stacking replaces ARC TransientLayer for Select inside Dialog and nested Dialog over WorkspaceShell.
  await withKitDom(async ({ server, root, settle }) => {
    const kit = await server.ssrLoadModule('/ui/components/kit/index.ts');

    function StackingHarness() {
      const [shellOpen, setShellOpen] = useState(true);
      const [parentOpen, setParentOpen] = useState(true);
      const [childOpen, setChildOpen] = useState(false);
      const [profile, setProfile] = useState('default');

      return h(
        'main',
        null,
        h(
          kit.WorkspaceShell,
          {
            open: shellOpen,
            title: 'Connections workspace',
            onClose: () => setShellOpen(false),
          },
          h('p', null, 'Workspace content'),
        ),
        h(
          kit.Dialog,
          { open: parentOpen, onOpenChange: setParentOpen },
          h(
            kit.DialogPopup,
            { closeLabel: 'Close parent' },
            h(kit.DialogHeader, null, h(kit.DialogTitle, null, 'Agent account')),
            h(
              kit.DialogBody,
              null,
              h(
                kit.Select,
                {
                  value: profile,
                  onValueChange: (next: string | null) => {
                    if (next !== null) setProfile(next);
                  },
                },
                h(
                  kit.SelectTrigger,
                  { 'aria-label': 'Browser profile' },
                  h(kit.SelectValue, { placeholder: 'Choose profile' }),
                ),
                h(
                  kit.SelectPopup,
                  null,
                  h(kit.SelectItem, { value: 'default' }, 'Default browser'),
                  h(kit.SelectItem, { value: 'chrome-profile-a' }, 'Chrome Profile A'),
                ),
              ),
              h('output', { 'aria-label': 'Selected profile' }, profile),
              h(kit.Button, { onClick: () => setChildOpen(true) }, 'Open child dialog'),
            ),
          ),
        ),
        h(
          kit.Dialog,
          { open: childOpen, onOpenChange: setChildOpen },
          h(
            kit.DialogPopup,
            { size: 'sm', closeLabel: 'Close child' },
            h(kit.DialogHeader, null, h(kit.DialogTitle, null, 'Tool permissions')),
            h(kit.DialogBody, null, h('p', null, 'Nested confirmation content')),
          ),
        ),
      );
    }

    const page = within(document.body);
    await act(async () => root.render(h(StackingHarness)));
    await settle();

    assert.ok(page.getByRole('region', { name: 'Connections workspace', hidden: true }));
    assert.ok(page.getByRole('dialog', { name: 'Agent account' }));

    // Opening and choosing a Select option inside Dialog updates value without closing the Dialog.
    const trigger = page.getByRole('combobox', { name: 'Browser profile' });
    await act(async () => fireEvent.click(trigger));
    await settle();

    const option = page.getByRole('option', { name: 'Chrome Profile A' });
    await act(async () => {
      fireEvent.pointerMove(option, { pointerType: 'mouse' });
      fireEvent.pointerDown(option, { button: 0, pointerType: 'mouse' });
      fireEvent.pointerUp(option, { button: 0, pointerType: 'mouse' });
      fireEvent.click(option, { detail: 1 });
    });
    await settle();

    assert.equal(page.getByRole('status', { name: 'Selected profile' }).textContent, 'chrome-profile-a');
    assert.equal(trigger.getAttribute('aria-expanded'), 'false');
    assert.ok(page.getByRole('dialog', { name: 'Agent account' }));

    // Nested child Dialog stacks cleanly above parent Dialog and closes without dismissing parent or WorkspaceShell.
    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Open child dialog' })));
    await settle();
    assert.ok(page.getByRole('dialog', { name: 'Tool permissions' }));
    assert.ok(page.getByRole('dialog', { name: 'Agent account', hidden: true }));

    await act(async () => fireEvent.click(page.getByRole('button', { name: 'Close child' })));
    await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Tool permissions' }), null);
    assert.ok(page.getByRole('dialog', { name: 'Agent account' }));
    assert.ok(page.getByRole('region', { name: 'Connections workspace', hidden: true }));

    // Pressing Escape while a Dialog is open dismisses only the Dialog, keeping WorkspaceShell open.
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await settle();
    assert.equal(page.queryByRole('dialog', { name: 'Agent account' }), null);
    assert.ok(page.getByRole('region', { name: 'Connections workspace' }));

    // Pressing Escape once no Dialog remains dismisses WorkspaceShell cleanly.
    await act(async () => fireEvent.keyDown(document, { key: 'Escape' }));
    await settle();
    assert.equal(page.queryByRole('region', { name: 'Connections workspace' }), null);
  });
});
