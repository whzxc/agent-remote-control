import { EntitySection, EntityCard } from './ui/EntityInventory';
import { PanelHeader } from "./ui/Panel";
import { useCallback, useState, type ReactNode } from 'react';
import PetPicker from '../pets/PetPicker';
import { controlSourcePlatform } from '../controlSources';
import { Plus, RefreshCw, Settings, X } from 'lucide-react';
import { t } from '../i18n';
import { resolveAgentQuota } from '../state/quota';
import { subscriptions } from '../state/subscriptions';
import { refreshAccounts, useAccounts } from '../state/accounts';
import { name, refreshAgents, type Agent } from '../state/agents';
import { managesAgentAccounts, selectAgentPanel } from '../state/overviewPanels';
import { AgentQuotaIcon } from '../subscriptions/AgentQuotaIcon';
import { AgentAccountCard } from './AccountCards';
import AgentAccountAdd from './AgentAccountAdd';
import { Button, DialogClose, Icon, IconButton, Loading, Notice } from './ui';
import type { ProviderAccount } from '../types';
import { readOnlyBrowser } from '../browserMode';

export default function AgentPlatformView({ agent, onSettings, widthControl }: {
  agent: Agent; onSettings: () => void; widthControl?: ReactNode;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const [login, setLogin] = useState<{ account?: ProviderAccount }>();
  const closeLogin = useCallback(() => setLogin(undefined), []);
  const state = useAccounts();
  const { snapshot } = subscriptions.use();
  const kind = managesAgentAccounts(agent.agent) ? agent.agent : undefined;
  const canLogin = kind && agent.installed && !readOnlyBrowser;
  const accounts = state.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));
  return <EntitySection as="section" className="agent-panel-layer agent-platform-view">
    <PanelHeader><header className="dialog-header agent-panel-header">
      <AgentQuotaIcon agent={agent.agent} provider={resolveAgentQuota(agent.agent, snapshot, state.items)} />
      <div className="agent-panel-heading"><h2>{name(agent)}</h2></div>
      <div className="actions">
        {canLogin && <Button data-add-agent-account onClick={() => setLogin({})}><Icon icon={Plus} />{t('accounts.addAgentAccount')}</Button>}
        <PetPicker scope={`agent:${agent.agent}`} name={name(agent)} platform={controlSourcePlatform(agent.agent).id} />
        {widthControl}
        <DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose>
      </div>
    </header></PanelHeader>
    <div className="agent-view-scroll" aria-busy={state.loading}>
      {state.error && <Notice action={<Button onClick={() => void refreshAccounts()}>{t('retry')}</Button>}>{state.error}</Notice>}
      {state.loading && !accounts.length && <Loading />}
      {accounts.map(account => <AgentAccountCard key={account.id} account={account}
        profile={account.agentProfiles.find(profile => profile.agent === agent.agent)!}
        onReauth={canLogin ? () => setLogin({ account }) : undefined}
        onSelect={() => selectAgentPanel({ type: 'agent', agent: agent.agent })} />)}
      {!accounts.length && !state.error && !state.loading && (canLogin ?
        <p className="agent-platform-empty">{t('accounts.empty')}</p> :
        <EntityCard className="native-agent-card">
          <p>{t(agent.installed && agent.available && agent.enabled ? 'agentReadyNoAccounts' : 'agentNeedsSetup')}</p>
          <div className="actions">
            <IconButton compact icon={RefreshCw} label={t('refreshAgents')} busy={refreshing} onClick={async () => {
              setRefreshing(true); try { await refreshAgents(true); } finally { setRefreshing(false); }
            }} />
            <IconButton compact icon={Settings} label={t('agents')} disabled={refreshing} onClick={onSettings} />
          </div>
        </EntityCard>)}
    </div>
    {login && kind && <AgentAccountAdd kind={kind} account={login.account} onClose={closeLogin} />}
  </EntitySection>;
}
