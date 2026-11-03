import { readOnlyBrowser } from "../../browserMode";
import PetPicker from '../../pets/PetPicker';
import { useId, useRef, useState } from 'react';
import { Check, Pencil, Trash2, X } from 'lucide-react';
import { api } from '../../api';
import { locale, t } from '../../i18n';
import { controlSource, controlSourcePlatform } from '../../controlSources';
import { connector, refreshConnector } from '../../state/connector';
import { sourceDate } from '../../sourcePresentation';
import type { ControlSource } from '../../state/types';
import { Button, Dialog, IconButton, Input, Notice, Status } from '../ui';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Sensitive } from '../Sensitive';
import SourceIcon from '../SourceIcon';

export default function ConnectorCard({ source }: { source: ControlSource }) {
  const { status } = connector.use();
  const ingress = status?.ingresses.find(item => item.id === source.ingressId);
  const grant = ingress?.oauth?.grants.find(item => item.id === source.credential.grantId);
  const product = controlSource(source.product);
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false), [label, setLabel] = useState(source.label);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const labelId = useId(), nameInput = useRef<HTMLInputElement>(null), editTrigger = useRef<HTMLButtonElement>(null);
  function finishEditing() {
    setEditing(false); setError('');
    requestAnimationFrame(() => editTrigger.current?.focus());
  }
  async function save() {
    if (busy) return;
    if (!label.trim()) { setError(t('fieldRequired')); nameInput.current?.focus(); return; }
    if (label.trim() === source.label) { finishEditing(); return; }
    setBusy(true); setError('');
    try { await api(`source/${source.id}`, 'PUT', { label: label.trim() }); await refreshConnector(); finishEditing(); }
    catch (e) { setError(String(e)); nameInput.current?.focus(); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setError('');
    try { await api(`source/${source.id}/disconnect`, 'POST'); await refreshConnector(); setRemoving(false); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const details = [
    [t('platforms.product'), product?.displayName],
    [t('platforms.client'), grant?.clientName !== product?.displayName ? grant?.clientName : undefined],
    [t('platforms.email'), source.authorizationFacts?.email],
    [t('platforms.organization'), source.authorizationFacts?.orgName],
    [t('platforms.accountId'), source.authorizationFacts?.accountId],
    [t('platforms.connection'), ingress?.name ?? source.connectionName],
    [t('platforms.added'), source.createdAt ? new Date(source.createdAt).toLocaleString(locale.get(), { hour12: false }) : undefined],
    [t('source.authorizedAt'), grant?.connectedAt || source.connectedAt ? sourceDate(grant?.connectedAt || source.connectedAt) : undefined],
    [t('source.lastSeen'), source.lastSeenAt ? sourceDate(source.lastSeenAt) : undefined],
  ].filter((row): row is [string, string] => !!row[1]);
  return <Card asChild className="border-solid border-border shadow-none"><section aria-label={source.label}>
    <CardHeader><div className="flex min-w-0 flex-wrap items-center gap-3"><SourceIcon platform={source.product} />
      {editing ? <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) finishEditing(); }
      }}>
        <div className="flex items-center gap-2"><Input ref={nameInput} id={labelId} aria-label={t('platforms.name')} aria-invalid={!!error} aria-describedby={error ? `${labelId}-error` : undefined} autoFocus required value={label} maxLength={120} readOnly={busy} onChange={event => setLabel(event.target.value)} />
          <IconButton icon={Check} label={t('save')} type="submit" busy={busy} />
          <IconButton icon={X} label={t('cancel')} disabled={busy} onClick={finishEditing} />
        </div>{error && <p id={`${labelId}-error`} className="field-error" role="alert">{error}</p>}
      </form> : <div className="connector-name flex min-w-0 flex-1 items-center gap-2"><h3 className="min-w-0 break-words">{source.label}</h3>
        <IconButton ref={editTrigger} disabled={readOnlyBrowser} className="connector-rename shrink-0" icon={Pencil} label={t('platforms.rename', { name: source.label })} onClick={() => { setLabel(source.label); setError(''); setEditing(true); }} />
      </div>}
      <Status tone={source.state === 'connected' ? 'success' : 'neutral'}>{t(`source.state.${source.state}`)}</Status>
      <PetPicker scope={`source:${source.id}`} name={source.label} platform={controlSourcePlatform(source.product).id} />
      <IconButton icon={Trash2} disabled={readOnlyBrowser || editing} label={t('platforms.remove', { name: source.label })} onClick={() => { setError(''); setRemoving(true); }} />
    </div></CardHeader>
    <CardContent><dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">{details.map(([name, value]) => <div key={name} className="min-w-0"><dt className="text-sm text-muted-foreground">{name}</dt><dd className="m-0 break-words"><Sensitive>{value}</Sensitive></dd></div>)}</dl></CardContent>
    {removing && <Dialog centered title={t('platforms.remove', { name: source.label })} busy={busy} onClose={() => setRemoving(false)} footer={<><Button disabled={busy} onClick={() => setRemoving(false)}>{t('cancel')}</Button><Button variant="danger" busy={busy} onClick={() => void remove()}>{t('remove')}</Button></>}>
      <p>{t('platforms.removeConfirm')}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
  </section></Card>;
}
