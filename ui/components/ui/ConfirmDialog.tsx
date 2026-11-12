import type { ReactNode } from 'react';
import { t } from '../../i18n';
import Dialog, { type DialogProps } from './Dialog';
import { DialogClose } from './LayerPortals';
import { Button } from './index';

type ConfirmDialogProps = Omit<DialogProps, 'footer'> & {
  confirmLabel: ReactNode;
  onConfirm: () => unknown;
  confirmVariant?: 'danger' | 'primary';
  actionsClassName?: string;
};

export default function ConfirmDialog({ confirmLabel, onConfirm, confirmVariant = 'danger', actionsClassName, ...props }: ConfirmDialogProps) {
  const actions = <>
    <DialogClose asChild><Button>{t('cancel')}</Button></DialogClose>
    <Button variant={confirmVariant} busy={props.busy} onClick={() => { void onConfirm(); }}>{confirmLabel}</Button>
  </>;
  return <Dialog {...props} footer={actionsClassName ? <div className={actionsClassName}>{actions}</div> : actions} />;
}
