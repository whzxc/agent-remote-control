import { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { ProviderAccount as Account } from '../types';
import { refreshAccounts } from '../state/accounts';
import { readOnlyBrowser } from '../browserMode';
import { t } from '../i18n';
import { Button, IconButton, Tag } from './ui';
import { Sensitive } from './Sensitive';
import AgentQuota from './AgentQuota';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
export function AgentAccountCard({ account, onSelect }: { account: Account; onSelect?: () => void }) {
  const [refreshing, setRefreshing] = useState(false);
  const provider = accountQuotaProvider(account.agentProfiles[0]?.agent ?? account.provider, account.quota);
  async function refresh() {
    setRefreshing(true);
    try { await refreshAccounts(); } finally { setRefreshing(false); }
  }
  return <section className="account-card" aria-label={account.alias}>
    <div className="account-heading">
      <h3>{onSelect ? <Button variant="link" disabled={refreshing} onClick={onSelect}>{account.alias}</Button> : account.alias}</h3>
      {!readOnlyBrowser && <IconButton compact icon={RefreshCw} label={t('usageRefresh')} busy={refreshing} disabled={!provider.eligible} onClick={() => void refresh()} />}
      {account.plan && <Tag>{account.plan}</Tag>}
    </div>
    {account.email && <Sensitive wrap>{account.email}</Sensitive>}
    <AgentQuota provider={provider} refreshing={refreshing} onRefresh={() => void refresh()} form="account" />
  </section>;
}
