import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { useAccounts } from '../state/accounts';
import { name, type Agent } from '../state/agents';
import { selectAgentPanel } from '../state/overviewPanels';
import { topologyAccountOrder } from '../topology/accountState';
import { orderedSubset } from '../topology/order';
import { AgentQuotaIcon } from '../subscriptions/QuotaRing';
import { AgentAccountCard } from './AccountCards';
import { DialogClose, IconButton, Notice } from './ui';

export default function AgentPlatformView({ agent, widthControl }: { agent: Agent; widthControl?: ReactNode }) {
  const state = useAccounts(), orders = topologyAccountOrder.use();
  const accounts = orderedSubset(state.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent)), orders[`1:${agent.agent}`] ?? []);
  return <section className="agent-panel-layer">
    <header className="dialog-header agent-panel-header">
      <AgentQuotaIcon agent={agent.agent} quota={null} />
      <div className="agent-panel-heading"><h2>{name(agent)}</h2></div>
      <div className="actions">{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
    <div className="agent-view-scroll">
      {state.error && <Notice>{state.error}</Notice>}
      {accounts.map(account => <AgentAccountCard key={account.id} account={account}
        onSelect={() => selectAgentPanel({ type: 'agent', agent: agent.agent, accountId: account.id })} />)}
      {!accounts.length && !state.error && <p role="status" className="muted">{t(state.loading ? 'loading' : 'accounts.empty')}</p>}
    </div>
  </section>;
}
