import { useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { api } from '../api';
import { t } from '../i18n';
import { controlSource } from '../controlSources';
import { isLocalSource } from '../sourcePresentation';
import { name as agentName } from '../state/agents';
import { connector, refreshConnector } from '../state/connector';
import { useAccounts, isUnidentified } from '../state/accounts';
import { navigation } from '../state/navigation';
import { ingressPanel, selectAgentPanel } from '../state/overviewPanels';
import type { ControlSource } from '../state/types';
import { Button, DialogClose, IconButton, Notice, SingleChoice, Switch, Tag } from './ui';
import { Sensitive, SensitiveIdentity } from './Sensitive';
import { AccountNotifications, AccountQuota, AccountSharedNotice } from './AccountCards';
import SourceConnection from './SourceConnection';
import SourceDispatches from './SourceDispatches';
import SourceIcon from './SourceIcon';
export function openSourceWorkspace(id: string) {
  ingressPanel.set(undefined);
  navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: id, remoteConnectionId: undefined }));
}
export default function SourcePanel({ source, widthControl }: { source: ControlSource; widthControl?: ReactNode }) {
  const { status } = connector.use(), state = useAccounts();
  const account = state.items.find(a => a.sources.includes(source.id));
  const ingress = status?.ingresses.find(i => i.id === source.ingressId);
  const [tab, setTab] = useState('activity'), [busy, setBusy] = useState(false), [error, setError] = useState('');
  if (isLocalSource(source)) return null;
  const platform = controlSource(source.product)?.displayName ?? agentName({ agent: source.product });
  return <>
    <header className="dialog-header source-account-header"><div className="source-account-brand"><SourceIcon platform={source.product} /></div>
      <div className="source-account-heading"><h2>{platform} · {account?.alias ?? t('accounts.identityUnavailable')}</h2><Sensitive>{account?.email}</Sensitive></div>
      <div className="actions"><Switch label={t('sourcePanel.enabled')} checked={!!ingress?.enabled} disabled={!ingress || busy} onChange={enabled => {
        if (!ingress) return;
        setBusy(true); setError(''); void api(`ingress/${ingress.id}`, 'PUT', { enabled }).then(refreshConnector).catch(e => setError(String(e))).finally(() => setBusy(false));
      }} />{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} disabled={busy} /></DialogClose></div>
    </header>
    <div className="side-panel-scroll source-panel-content">
      {error && <Notice>{error}</Notice>}
      <SingleChoice label={t('accounts.sourceTabs')} value={tab} onChange={setTab} options={['activity', 'account', 'connection'].map(value => ({ value, label: t(`accounts.tab.${value}`) }))} />
      {tab === 'activity' && <SourceDispatches sourceId={source.id} />}
      {tab === 'account' && <>{state.error && <Notice>{state.error}</Notice>}{account ? <>
        <section className="account-card"><div className="source-section-heading"><h3>{account.alias}</h3>{account.plan && <Tag>{account.plan}</Tag>}</div><SensitiveIdentity email={account.email} orgName={account.orgName} wrap /><div><Sensitive wrap>{account.identityKey}</Sensitive></div><p className="muted">{t(isUnidentified(account) ? 'accounts.unidentified' : 'accounts.whoami')}</p>
          <Button variant="link" onClick={() => { ingressPanel.set(undefined); navigation.set(old => ({ ...old, page: 'accounts', accountId: account.id, remoteSourceId: undefined })); }}>{t('accounts.openAccount')}</Button></section>
        {!!account.agentProfiles.length && <section className="account-card"><AccountSharedNotice />{account.agentProfiles.map(profile => <Button key={profile.profileId} variant="link" onClick={() => { selectAgentPanel({ type: 'agent', agent: profile.agent, accountId: account.id }); navigation.set(old => ({ ...old, page: 'overview', remoteSourceId: undefined })); }}>{agentName(profile)} · {account.alias}</Button>)}</section>}
        <AccountQuota account={account} /><AccountNotifications account={account} />
      </> : <p role="status" className="muted">{t(state.loading ? 'loading' : 'accounts.identityUnavailable')}</p>}</>}
      {tab === 'connection' && <SourceConnection source={source} onConnection={id => { ingressPanel.set(undefined); navigation.set(old => ({ ...old, page: 'remote', remoteSourceId: undefined, remoteConnectionId: id })); }} />}
    </div>
  </>;
}
