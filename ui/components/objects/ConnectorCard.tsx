import { useDialogCompletion } from "../ui/Dialog";
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
import { DialogClose, Button, Dialog, IconButton, Input, Notice } from '../ui';
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
  const completion = useDialogCompletion(() => setRemoving(false));
  async function remove() {
    setBusy(true); setError('');
    try { await api(`source/${source.id}/disconnect`, 'POST'); await refreshConnector(); await completion.finish(); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const identity = [
    [t('platforms.product'), product?.displayName],
    [t('platforms.client'), grant?.clientName !== product?.displayName ? grant?.clientName : undefined],
    [t('platforms.email'), source.authorizationFacts?.email],
    [t('platforms.organization'), source.authorizationFacts?.orgName],
    [t('platforms.accountId'), source.authorizationFacts?.accountId],
  ].filter((row): row is [string, string] => !!row[1]);
  const connection = [
    [t('platforms.connection'), ingress?.name ?? source.connectionName],
    [t('platforms.added'), source.createdAt ? new Date(source.createdAt).toLocaleString(locale.get(), { hour12: false }) : undefined],
  ].filter((row): row is [string, string] => !!row[1]);
  const activity = [
    [t('source.authorizedAt'), grant?.connectedAt || source.connectedAt ? sourceDate(grant?.connectedAt || source.connectedAt) : undefined],
    [t('source.lastSeen'), source.lastSeenAt ? sourceDate(source.lastSeenAt) : undefined],
  ].filter((row): row is [string, string] => !!row[1]);
  const facts = identity.length <= 1 ? [[...identity, ...connection], activity] : [identity, connection, activity];
  return <Card asChild className="gap-3"><section className="connector-card" aria-label={source.label}>
    <CardHeader><div className="connector-card-heading"><SourceIcon platform={source.product} />
      {editing ? <form className="min-w-0 flex-1" onSubmit={event => { event.preventDefault(); void save(); }} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) finishEditing(); }
      }}>
        <div className="flex items-center gap-2"><Input ref={nameInput} id={labelId} aria-label={t('platforms.name')} aria-invalid={!!error} aria-describedby={error ? `${labelId}-error` : undefined} autoFocus required value={label} maxLength={120} readOnly={busy} onChange={event => setLabel(event.target.value)} />
          <IconButton icon={Check} label={t('save')} type="submit" busy={busy} />
          <IconButton icon={X} label={t('cancel')} disabled={busy} onClick={finishEditing} />
        </div>{error && <p id={`${labelId}-error`} className="field-error" role="alert">{error}</p>}
      </form> : <div className="connector-name"><h3>{source.label}</h3><span className="connector-state" data-connected={source.state === 'connected' || undefined}>· {t(`source.state.${source.state}`)}</span></div>}
      {editing && <span className="connector-state" data-connected={source.state === 'connected' || undefined}>{t(`source.state.${source.state}`)}</span>}
      <div className="connector-actions">
      {!editing && <IconButton compact ref={editTrigger} disabled={readOnlyBrowser || busy} icon={Pencil} label={t('platforms.rename', { name: source.label })} onClick={() => { setLabel(source.label); setError(''); setEditing(true); }} />}
      <PetPicker scope={`source:${source.id}`} name={source.label} platform={controlSourcePlatform(source.product).id} />
      <IconButton compact icon={Trash2} disabled={readOnlyBrowser || editing || busy} label={t('platforms.remove', { name: source.label })} onClick={() => { setError(''); setRemoving(true); }} />
      </div>
    </div></CardHeader>
    <CardContent><dl className="connector-facts">{facts.filter(group => group.length).map((group, index) => <div className="connector-fact-group" key={index}>{group.map(([name, value]) => <div className="connector-fact" key={name}><dt>{name}</dt><dd><Sensitive>{value}</Sensitive></dd></div>)}</div>)}</dl></CardContent>
    {removing && <Dialog layerId={completion.layerId} size="s" title={t('platforms.remove', { name: source.label })} busy={busy} onClose={() => setRemoving(false)} footer={<><DialogClose asChild><Button>{t("cancel")}</Button></DialogClose><Button variant="danger" busy={busy} onClick={() => void remove()}>{t('remove')}</Button></>}>
      <p>{t('platforms.removeConfirm')}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
  </section></Card>;
}
