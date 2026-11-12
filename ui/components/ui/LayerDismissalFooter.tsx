import { useLayoutEffect, useRef } from 'react';
import { layers, type Dismissal } from '../../state/layers';
import { t } from '../../i18n';
import { Button } from './index';

export function LayerDismissalFooter({ id, status, cancellable, close }: {
  id: string; status: Dismissal; cancellable: boolean; close: () => void;
}) {
  const safeAction = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (status !== 'none') safeAction.current?.focus({ preventScroll: true }); }, [status]);
  if (status === 'none') return null;
  return <footer className="dialog-footer layer-dismissal" role="status">
    <p>{t(status === 'discard' ? 'layers.discard' : 'layers.runningClose')}</p>
    <div className="actions">
      {status === 'discard' && <Button variant="danger" onClick={close}>{t('layers.discardAction')}</Button>}
      {status === 'running' && cancellable && <Button variant="danger" onClick={() => void layers.stopAndClose(id)}>{t('layers.stopClose')}</Button>}
      <Button ref={safeAction} variant="primary" onClick={() => layers.keepOpen(id)}>{t(status === 'discard' ? 'layers.keepEditing' : 'layers.keepOpen')}</Button>
    </div>
  </footer>;
}
