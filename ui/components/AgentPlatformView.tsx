import { useCallback, useState, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n';
import { resolveAgentQuota } from '../state/quota';
import { subscriptions } from '../state/subscriptions';
import { refreshAccounts, useAccounts } from '../state/accounts';
import { name, refreshAgents, type Agent } from '../state/agents';
import { managesAgentAccounts, selectAgentPanel } from '../state/overviewPanels';
import { AgentQuotaIcon } from '../subscriptions/AgentQuotaIcon';
import { IconButton } from './kit/button';
import { DialogClose } from './ui/Dialog';
import { EntityCard, EntitySection } from './ui/EntityInventory';
import { PanelHeader } from './ui/Panel';
import { AgentAccountCard } from './AccountCards';
import AgentAccountAdd from './AgentAccountAdd';
import { AgentPlatformContentView, AgentPlatformHeaderView } from './AgentPlatformContentView';
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
  const canLogin = Boolean(kind && agent.installed && !readOnlyBrowser);
  const accounts = state.items.filter(account => account.agentProfiles.some(profile => profile.agent === agent.agent));

  return (
    <>
      <AgentPlatformContentView
        SectionWrapper={EntitySection}
        NativeCardWrapper={EntityCard}
        header={
          <PanelHeader>
            <AgentPlatformHeaderView
              brandSlot={<AgentQuotaIcon agent={agent.agent} provider={resolveAgentQuota(agent.agent, snapshot, state.items)} />}
              title={name(agent)}
              addAccountLabel={canLogin ? t('accounts.addAgentAccount') : undefined}
              onAddAccount={canLogin ? () => setLogin({}) : undefined}
              widthControl={widthControl}
              closeAction={<DialogClose asChild><IconButton compact icon={X} label={t('close')} /></DialogClose>}
            />
          </PanelHeader>
        }
        loading={state.loading}
        loadingLabel={t('loading')}
        error={state.error || undefined}
        retryLabel={t('retry')}
        onRetry={() => void refreshAccounts()}
        hasAccounts={accounts.length > 0}
        canLogin={canLogin}
        emptyMessage={t('accounts.empty')}
        nativeStatusMessage={t(agent.installed && agent.available && agent.enabled ? 'agentReadyNoAccounts' : 'agentNeedsSetup')}
        refreshAgentsLabel={t('refreshAgents')}
        settingsLabel={t('agents')}
        refreshingNative={refreshing}
        onRefreshNative={async () => {
          setRefreshing(true);
          try { await refreshAgents(true); }
          finally { setRefreshing(false); }
        }}
        onSettings={onSettings}
      >
        {accounts.map(account => (
          <AgentAccountCard
            key={account.id}
            account={account}
            profile={account.agentProfiles.find(profile => profile.agent === agent.agent)!}
            onReauth={canLogin ? () => setLogin({ account }) : undefined}
            onSelect={() => selectAgentPanel({ type: 'agent', agent: agent.agent })}
          />
        ))}
      </AgentPlatformContentView>
      {login && kind && <AgentAccountAdd kind={kind} account={login.account} onClose={closeLogin} />}
    </>
  );
}
