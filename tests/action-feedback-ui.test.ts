import test from 'node:test';
import assert from 'node:assert/strict';
import {act,createElement as h,useState} from 'react';
import {within,fireEvent} from '@testing-library/dom';
import {assertNodeIdentity} from './helpers/dom-assert.ts';
import {withDialog} from './helpers/layers-ui.ts';

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
