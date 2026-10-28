import { useState } from 'react';
import { t } from '../i18n';
import { connectionKind } from '../sourcePresentation';
import type { Ingress } from '../state/types';
import IngressDialog from './IngressDialog';
import { Button, CopyField, Notice } from './ui';

export default function PlatformConnection({ ingress, onConnection }: { ingress: Ingress; onConnection: (id: string) => void }) {
  const [editing, setEditing] = useState(false);
  if (ingress.id === 'local-cli') return null;
  return <>
    <section className="source-connection-card">
      <div className="source-section-heading">
        <div className="actions"><Button variant="ghost" data-source-connection onClick={() => onConnection(ingress.id)}>{ingress.name}</Button><span className="muted">{t(`source.kind.${connectionKind(ingress)}`)}</span></div>
        {!['local', 'relay'].includes(ingress.transport) && <Button data-change-connection onClick={() => setEditing(true)}>{t('edit')}</Button>}
      </div>
      {ingress.url && <CopyField value={ingress.url} label={t('source.copyAddress')} />}
      {ingress.error && <Notice>{ingress.error}</Notice>}
    </section>
    {editing && <IngressDialog ingress={ingress} onClose={() => setEditing(false)} onRemoved={() => setEditing(false)} onSaved={() => setEditing(false)} />}
  </>;
}
