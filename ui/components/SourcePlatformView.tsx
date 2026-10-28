import { useEffect, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { controlSource } from '../controlSources';
import { isPendingSource } from '../sourcePresentation';
import { name as agentName } from '../state/agents';
import { useAccounts } from '../state/accounts';
import { connector, refreshConnector } from '../state/connector';
import { navigation } from '../state/navigation';
import { ingressPanel } from '../state/overviewPanels';
import { topologyAccountOrder } from '../topology/accountState';
import { orderedSubset } from '../topology/order';
import { Button, DialogClose, IconButton, Notice, SingleChoice, Switch, Tag } from './ui';
import { Sensitive, SensitiveIdentity } from './Sensitive';
import { AccountQuota } from './AccountCards';
import PlatformConnection from './PlatformConnection';
import SourceIcon from './SourceIcon';

export default function SourcePlatformView({ platform, widthControl, onBusy }: { platform: string; widthControl?: ReactNode; onBusy?: (busy: boolean) => void }) {
  const state = useAccounts(), { status, sources } = connector.use(), orders = topologyAccountOrder.use();
  const platformSources = sources.filter(source => source.product === platform && source.state !== 'revoked'
    && !isPendingSource(source, status?.ingresses ?? []));
  const sourceIds = new Set(platformSources.map(source => source.id));
  const ingress = status?.ingresses.find(entry => entry.id === platformSources[0]?.ingressId);
  const accounts = orderedSubset(state.items.filter(account => account.sources.some(id => sourceIds.has(id))), orders[`-1:${platform}`] ?? []);
  const label = controlSource(platform)?.displayName ?? agentName({ agent: platform });
  const [tab, setTab] = useState('account'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { onBusy?.(busy); }, [busy, onBusy]);
  async function connect(connected: boolean) {
    if (!ingress || busy) return;
    setBusy(true); setError('');
    try {
      if (connected && !ingress.enabled) await api(`ingress/${ingress.id}`, 'PUT', { enabled: true });
      await api(`ingress/${ingress.id}/${connected ? 'start' : 'stop'}`, 'POST');
    } catch (error) { setError(String(error)); }
    finally {
      await refreshConnector().catch(error => setError(previous => previous || String(error)));
      setBusy(false);
    }
  }
  return <>
    <header className="dialog-header source-account-header">
      <div className="source-account-brand"><SourceIcon platform={platform} /></div>
      <div className="source-account-heading"><h2>{label}</h2></div>
      <div className="actions"><Switch label={t(ingress?.running ? 'disconnect' : 'connect')} checked={!!ingress?.running}
        disabled={!ingress || busy || ['starting', 'stopping'].includes(ingress.state)} onChange={connected => void connect(connected)} />
        {widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} disabled={busy} /></DialogClose></div>
    </header>
    <div className="side-panel-scroll source-panel-content">
      {error && <Notice>{error}</Notice>}
      <SingleChoice label={label} value={tab} onChange={setTab} options={['account', 'connection'].map(value => ({ value, label: t(`accounts.tab.${value}`) }))} />
      {tab === 'account' && <>
        {state.error && <Notice>{state.error}</Notice>}
        {accounts.map(account => <section className="account-card" key={account.id} aria-label={account.alias}>
          <div className="source-section-heading">
            <div className="actions"><h3>{account.alias}</h3>{account.plan && <Tag>{account.plan}</Tag>}</div>
            <Button variant="link" onClick={() => {
              ingressPanel.set(undefined);
              navigation.set(old => ({ ...old, page: 'accounts', accountId: account.id, remoteSourceId: undefined }));
            }}>{t('accounts.openAccount')}</Button>
          </div>
          <SensitiveIdentity email={account.email} orgName={account.orgName} wrap />
          <div><Sensitive wrap>{account.identityKey}</Sensitive></div>
          <AccountQuota account={account} />
        </section>)}
        {!accounts.length && !state.error && <p role="status" className="muted">{t(state.loading ? 'loading' : 'accounts.empty')}</p>}
      </>}
      {tab === 'connection' && (ingress ? <PlatformConnection key={ingress.id} ingress={ingress} onConnection={id => {
        ingressPanel.set(undefined);
        navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: undefined, remoteConnectionId: id }));
      }} /> : <Notice tone="warning">{t('source.connectionRemoved')}</Notice>)}
    </div>
  </>;
}
