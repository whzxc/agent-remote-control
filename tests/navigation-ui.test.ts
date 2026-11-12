import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement as h,useState} from 'react';
import {within,fireEvent} from '@testing-library/dom';
import {assertNodeIdentity} from './helpers/dom-assert.ts';
import {withDialog} from './helpers/layers-ui.ts';

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
