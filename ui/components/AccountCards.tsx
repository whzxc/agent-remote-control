import { useState } from 'react';
import type { ProviderAccount as Account } from '../types';
import { refreshAccounts } from '../state/accounts';
import { Button, Tag } from './ui';
import { Sensitive } from './Sensitive';
import AgentQuota from './AgentQuota';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
export function AgentAccountCard({ account, onSelect }: { account: Account; onSelect?: () => void }) {
  return <section className="account-card" aria-label={account.alias}>
    <div className="source-section-heading">
      <div className="actions"><h3>{onSelect ? <Button variant="link" onClick={onSelect}>{account.alias}</Button> : account.alias}</h3>{account.plan && <Tag>{account.plan}</Tag>}</div>
    </div>
    <Sensitive wrap>{account.email}</Sensitive>
    <AccountQuota account={account} />
  </section>;
}
export function AccountQuota({ account }: { account: Account }) {
  const [refreshing, setRefreshing] = useState(false);
  const provider = accountQuotaProvider(account.agentProfiles[0]?.agent ?? account.provider, account.quota);
  async function refresh() {
    setRefreshing(true);
    try { await refreshAccounts(); } finally { setRefreshing(false); }
  }
  return <AgentQuota provider={provider} refreshing={refreshing} onRefresh={() => void refresh()} />;
}
