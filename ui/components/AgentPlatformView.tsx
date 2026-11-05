import PetPicker from '../pets/PetPicker';
import { controlSourcePlatform } from '../controlSources';
import { useState, type ReactNode } from 'react';
import { RefreshCw, Settings, X } from 'lucide-react';
import { t } from '../i18n';
import { useAccounts } from '../state/accounts';
import { name, refreshAgents, type Agent } from '../state/agents';
import { selectAgentPanel } from '../state/overviewPanels';
import { topologyAccountOrder } from '../topology/accountState';
import { orderedSubset } from '../topology/order';
import { AgentQuotaIcon } from '../subscriptions/QuotaRing';
import { AgentAccountCard } from './AccountCards';
import { DialogClose, IconButton, Notice } from './ui';
import { Card } from './ui/card';

export default function AgentPlatformView({ agent, onSettings, widthControl }: { agent: Agent; onSettings: () => void; widthControl?: ReactNode }) {
  const [refreshing, setRefreshing] = useState(false);
  const state = useAccounts(), orders = topologyAccountOrder.use();
  const accounts = orderedSubset(state.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent)), orders[`1:${agent.agent}`] ?? []);
  return <section className="agent-panel-layer agent-platform-view">
    <header className="dialog-header agent-panel-header">
      <AgentQuotaIcon agent={agent.agent} quota={null} />
      <div className="agent-panel-heading"><h2>{name(agent)}</h2></div>
      <div className="actions"><PetPicker scope={`agent:${agent.agent}`} name={name(agent)} platform={controlSourcePlatform(agent.agent).id} />{widthControl}<DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose></div>
    </header>
    <div className="agent-view-scroll">
      {state.error && <Notice>{state.error}</Notice>}
      {accounts.map(account => <AgentAccountCard key={account.id} account={account}
        onSelect={() => selectAgentPanel({ type: 'agent', agent: agent.agent, accountId: account.id })} />)}
      {!accounts.length && !state.error && <Card className="native-agent-card">
        <p>{t(agent.installed && agent.available && agent.enabled ? 'agentReadyNoAccounts' : 'agentNeedsSetup')}</p>
        <div className="actions">
        <IconButton compact icon={RefreshCw} label={t('refreshAgents')} busy={refreshing} onClick={async () => { setRefreshing(true); try { await refreshAgents(true); } finally { setRefreshing(false); } }} />
        <IconButton compact icon={Settings} label={t('agents')} disabled={refreshing} onClick={onSettings} />
        </div>
      </Card>}
    </div>
  </section>;
}
