import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { api } from '../../api';
import { locale, t } from '../../i18n';
import { controlSource } from '../../controlSources';
import { connector, refreshConnector } from '../../state/connector';
import { sourceDate } from '../../sourcePresentation';
import type { ControlSource } from '../../state/types';
import { Button, Dialog, Field, IconButton, Input, Status } from '../ui';
import { Card, CardContent, CardHeader } from '../ui/card';
import { Sensitive } from '../Sensitive';
import SourceIcon from '../SourceIcon';

export default function ConnectorCard({ source }: { source: ControlSource }) {
  const { status } = connector.use();
  const ingress = status?.ingresses.find(item => item.id === source.ingressId);
  const grant = ingress?.oauth?.grants.find(item => item.id === source.credential.grantId);
  const product = controlSource(source.product);
  const [editing, setEditing] = useState(false), [label, setLabel] = useState(source.label);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function save() {
    if (!label.trim()) { setError(t('fieldRequired')); document.getElementById('connector-label')?.focus(); return; }
    setBusy(true); setError('');
    try { await api(`source/${source.id}`, 'PUT', { label: label.trim() }); await refreshConnector(); setEditing(false); }
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
    <CardHeader><div className="flex min-w-0 items-center gap-3"><SourceIcon platform={source.product} /><h3 className="min-w-0 flex-1 break-words">{source.label}</h3>
      <Status tone={source.state === 'connected' ? 'success' : 'neutral'}>{t(`source.state.${source.state}`)}</Status>
      <IconButton icon={Pencil} label={t('platforms.rename', { name: source.label })} onClick={() => { setLabel(source.label); setError(''); setEditing(true); }} />
    </div></CardHeader>
    <CardContent><dl className="m-0 grid grid-cols-1 gap-3 sm:grid-cols-2">{details.map(([name, value]) => <div key={name} className="min-w-0"><dt className="text-sm text-muted-foreground">{name}</dt><dd className="m-0 break-words"><Sensitive>{value}</Sensitive></dd></div>)}</dl></CardContent>
    {editing && <Dialog centered title={t('platforms.rename', { name: source.label })} busy={busy} onClose={() => setEditing(false)} footer={<><Button disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</Button><Button variant="primary" busy={busy} type="submit" form="connector-name">{t('save')}</Button></>}>
      <form id="connector-name" onSubmit={event => { event.preventDefault(); void save(); }}><Field id="connector-label" label={t('platforms.name')} error={error}><Input id="connector-label" autoFocus value={label} maxLength={120} disabled={busy} onChange={event => setLabel(event.target.value)} /></Field></form>
    </Dialog>}
  </section></Card>;
}
