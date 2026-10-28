import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { controlSource } from '../controlSources';
import { isPendingSource } from '../sourcePresentation';
import { name as agentName } from '../state/agents';
import { useAccounts, isUnidentified } from '../state/accounts';
import { connector } from '../state/connector';
import { navigation } from '../state/navigation';
import { ingressPanel, selectAgentPanel } from '../state/overviewPanels';
import { topologyAccountOrder } from '../topology/accountState';
import { orderedSubset } from '../topology/order';
import { Button, DialogClose, IconButton, Notice, Tag } from './ui';
import { Sensitive, SensitiveIdentity } from './Sensitive';
import { AccountQuota, AccountSharedNotice } from './AccountCards';
import SourceIcon from './SourceIcon';

export default function SourcePlatformView({ platform, widthControl }: { platform: string; widthControl?: ReactNode }) {
  const state = useAccounts(), { status, sources } = connector.use(), orders = topologyAccountOrder.use();
  const sourceIds = new Set(sources.filter(source => source.product === platform && source.state !== 'revoked'
    && !isPendingSource(source, status?.ingresses ?? [])).map(source => source.id));
  const accounts = orderedSubset(state.items.filter(account => account.sources.some(id => sourceIds.has(id))), orders[`-1:${platform}`] ?? []);
  const label = controlSource(platform)?.displayName ?? agentName({ agent: platform });
  return <>
    <header className="dialog-header source-account-header">
      <div className="source-account-brand"><SourceIcon platform={platform} /></div>
      <div className="source-account-heading"><h2>{label}</h2></div>
      <div className="actions">{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
    <div className="side-panel-scroll source-panel-content">
      {state.error && <Notice>{state.error}</Notice>}
      {accounts.map(account => <section className="source-detail" key={account.id} aria-label={account.alias}>
        <section className="account-card">
          <div className="source-section-heading"><h3>{account.alias}</h3>{account.plan && <Tag>{account.plan}</Tag>}</div>
          <SensitiveIdentity email={account.email} orgName={account.orgName} wrap />
          <div><Sensitive wrap>{account.identityKey}</Sensitive></div>
          <p className="muted">{t(isUnidentified(account) ? 'accounts.unidentified' : 'accounts.whoami')}</p>
          <Button variant="link" onClick={() => {
            ingressPanel.set(undefined);
            navigation.set(old => ({ ...old, page: 'accounts', accountId: account.id, remoteSourceId: undefined }));
          }}>{t('accounts.openAccount')}</Button>
        </section>
        {!!account.agentProfiles.length && <section className="account-card">
          <AccountSharedNotice />
          {account.agentProfiles.map(profile => <Button key={profile.profileId} variant="link" onClick={() => {
            selectAgentPanel({ type: 'agent', agent: profile.agent, accountId: account.id });
            navigation.set(old => ({ ...old, page: 'overview', remoteSourceId: undefined }));
          }}>{agentName(profile)} · {account.alias}</Button>)}
        </section>}
        <AccountQuota account={account} />
      </section>)}
      {!accounts.length && !state.error && <p role="status" className="muted">{t(state.loading ? 'loading' : 'accounts.empty')}</p>}
    </div>
  </>;
}
