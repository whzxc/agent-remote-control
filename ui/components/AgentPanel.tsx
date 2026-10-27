import { AgentPlatformCard } from './objects/agent-platform';
import { AgentAccountCard, AgentAccountRow } from './objects/agent-account';
import { InlineName } from './composites/InlineName';
import { ContextIcon } from './composites/ContextIcon';
import { ContextSettings } from './composites/ContextSettings';
import AddAccount from './AddAccount';
import { ViewStack, Dialog, DialogClose, IconButton, Notice, Button, Empty, Loading } from './ui';
import { useReducedMotion } from '../state/appEnvironment';
import { agentPanel, selectAgentPanel } from '../state/overviewPanels';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowLeft, X, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { accountsApi } from '../api';
import { t } from '../i18n';
import { useAccounts, refreshAccounts } from '../state/accounts';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
import AgentQuota from './AgentQuota';
import { agentActivity } from '../state/activity';
import { compactAgentVersion, name, type Agent } from '../state/agents';
import AgentConversations from './AgentConversations';
import ActivityTimeline from './ActivityTimeline';
import type { SurfaceRect } from '../motion/surface';
import type { ProviderAccount } from '../types';
import { accountOwns } from '../accountPresentation';

function AgentView({ agent, account, accountId, accounts, loading, accountError, expanded, onToggleWidth, active, resizable = true }: {
  agent: Agent; active: boolean; resizable?: boolean; account?: ProviderAccount; accountId?: string; accounts: ProviderAccount[]; loading: boolean; accountError: string;
  expanded: boolean; onToggleWidth: () => void;
}) {
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false), [removing, setRemoving] = useState(false), [busy, setBusy] = useState(false);
  const provider = account ? accountQuotaProvider(agent.agent, account.quota) : undefined;
  const providerError = provider?.windows.some(window => Number.isFinite(window.usedPercent)) ? provider.error?.message : undefined;
  async function refresh() {
    setRefreshing(true);
    try { await refreshAccounts(); } finally { setRefreshing(false); }
  }
  async function remove() {
    if (!account || busy) return;
    setBusy(true); setError('');
    try { await accountsApi.remove({ id: account.id, running: 'finish' }); await refreshAccounts(); agentPanel.set({ agent: agent.agent }); }
    catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  }
  const visibleAccounts = accounts.filter(item => !item.removedAt && item.agentProfiles.some(profile => profile.agent === agent.agent));
  const headerActions = <>
    {account ? <ContextIcon icon={Trash2} label={t('remove')} onClick={() => setRemoving(true)} />
      : !accountId && <ContextIcon icon={Plus} label={t('accounts.add')} onClick={() => setAdding(true)} />}
    {resizable && <ContextSettings label={t('context.panelWidth')} value={expanded ? 'wide' : 'normal'} options={[{ value: 'normal', label: t('context.normal') }, { value: 'wide', label: t('context.wide') }]} onChange={value => { if ((value === 'wide') !== expanded) onToggleWidth(); }} />}
    <DialogClose asChild><IconButton icon={X} label={t('close')} /></DialogClose>
  </>;
  const back = <IconButton icon={ArrowLeft} label={t('back')} onClick={() => selectAgentPanel({ type: 'back' })} />;
  return <section className="agent-overview-layer flex h-full min-h-0 w-full flex-col">
    {account ? <AgentAccountCard account={account} agent={agent} frame="panel" icon={back} showProfiles={false}
      title={<h2 aria-label={account.alias} tabIndex={-1}><InlineName value={account.alias} revealed onSave={async alias => { await accountsApi.update({ id: account.id, alias }); await refreshAccounts(); }} /></h2>}
      headerActions={headerActions}>
      {providerError && <Notice action={<IconButton icon={RefreshCw} label={t('usageRefresh')} busy={refreshing} onClick={() => void refresh()} />}>{providerError}</Notice>}
      {provider && <AgentQuota provider={provider} onRefresh={() => void refresh()} refreshing={refreshing} />}
      <AgentConversations key={`${agent.agent}:${account.id}`} agent={agent.agent} account={account} accountId={account.id} active={active} />
    </AgentAccountCard> : <AgentPlatformCard agent={agent} frame="panel" quota={null}
      titleActions={accountId ? back : undefined} secondary={<span title={agent.version ?? undefined}>{compactAgentVersion(agent.version)}</span>} headerActions={headerActions}>
      {loading && <Loading />}
      {accountError && <Notice>{accountError}</Notice>}
      {accountId ? <Notice>{t('accounts.identityUnavailable')}</Notice> : <>
        {visibleAccounts.map(item => <AgentAccountRow key={item.id} account={item} agent={agent.agent} onOpen={() => selectAgentPanel({ type: 'agent', agent: agent.agent, accountId: item.id })} />)}
        {!loading && !visibleAccounts.length && <Empty>{t('panels.noAccounts')}</Empty>}
      </>}
    </AgentPlatformCard>}
    {error && <Notice>{error}</Notice>}
    {adding && <AddAccount initialKind={agent.agent === 'claude' || agent.agent === 'codex' ? agent.agent : 'api-key'} onClose={() => setAdding(false)} />}
    {removing && <Dialog centered title={`${t('remove')} · ${account?.alias}`} busy={busy} onClose={() => { if (!busy) setRemoving(false); }}
      footer={<><Button disabled={busy} onClick={() => setRemoving(false)}>{t('cancel')}</Button><Button variant="danger" busy={busy} onClick={() => void remove()}>{t('remove')}</Button></>}>
      <p>{t('accounts.removeConsequence')}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
  </section>;
}

export default function AgentPanel({ agent, onPanelFrame, width, expanded, onToggleWidth, dockRect }: {
  agent: Agent; width?: number; dockRect?: SurfaceRect;
  onPanelFrame?: (rect: SurfaceRect | null) => void;
  expanded: boolean; onToggleWidth: () => void;
}) {
  const selected = agentPanel.use()!, { error } = agentActivity.use();
  const accountState = useAccounts(), account = accountState.items.find(account => accountOwns(account, selected.accountId));
  const reduced = useReducedMotion(), previous = useRef(selected), content = useRef<HTMLDivElement>(null);
  const session = selected.session, taskTitleId = useId();
  const returning = previous.current.agent === selected.agent && previous.current.accountId === selected.accountId && !!previous.current.session && !session;
  useLayoutEffect(() => {
    if (returning) {
      const id = previous.current.session!.id;
      requestAnimationFrame(() => {
        const row = Array.from(content.current?.querySelectorAll<HTMLButtonElement>("[data-activity-session]") ?? [])
          .find(node => node.dataset.activitySession === JSON.stringify([selected.agent, id]));
        (row ?? [...(content.current?.querySelectorAll<HTMLElement>('.agent-overview-layer h2') ?? [])].find(node => !node.closest('[hidden]')))?.focus({ preventScroll: true });
      });
    }
    if (!returning && previous.current.accountId !== selected.accountId) {
      const id = selected.accountId ? undefined : previous.current.accountId;
      requestAnimationFrame(() => {
        const row = id && content.current?.querySelector<HTMLElement>(`[data-hover-target="${CSS.escape(id)}"]`);
        (row || [...(content.current?.querySelectorAll<HTMLElement>('h2') ?? [])].find(node => !node.closest('[hidden]')))?.focus({ preventScroll: true });
      });
    }
    previous.current = selected;
  }, [selected]);
  return <Dialog width={width} dockRect={dockRect} dock="right" expanded={expanded} headerless title={account?.alias ?? name(agent)} labelledBy={session ? taskTitleId : undefined}
    onBack={session || selected.accountId ? () => selectAgentPanel({ type: "back" }) : undefined}
    originKey={agent.agent} closeRequested={selected.closing}
    onCloseStart={() => agentPanel.set(old => old?.agent === agent.agent && old.accountId === selected.accountId ? { ...old, closing: true } : old)}
    onClose={() => { const current = agentPanel.get(); if (current?.agent === agent.agent && current.accountId === selected.accountId && current.closing) selectAgentPanel({ type: "closed" }); }}
    returnFocus={`[data-agent-node="${CSS.escape(agent.agent)}"]${selected.accountId ? `[data-account-id="${CSS.escape(account?.id ?? selected.accountId)}"]` : ""} button`} onPanelFrame={onPanelFrame}>
    {error && <span className="sr-only" role="status">{t("activity.disconnected")}</span>}
    <ViewStack ref={content}>
      <ViewStack hidden={!!session || !!selected.accountId}>
        <AgentView key={agent.agent} resizable={!dockRect} agent={agent} accounts={accountState.items} loading={accountState.loading} accountError={accountState.error} active={!session && !selected.accountId} expanded={expanded} onToggleWidth={onToggleWidth} />
      </ViewStack>
      {selected.accountId && <ViewStack asChild hidden={!!session}><motion.div key={`${agent.agent}:${selected.accountId}`}
        initial={{ opacity: reduced ? 1 : 0, x: 0 }} animate={{ opacity: session ? 0 : 1, x: reduced || !session ? 0 : -12 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        <AgentView resizable={!dockRect} agent={agent} account={account} accounts={accountState.items} loading={accountState.loading} accountError={accountState.error} accountId={selected.accountId} active={!session} expanded={expanded} onToggleWidth={onToggleWidth} />
      </motion.div></ViewStack>}
      {session && <ViewStack asChild><motion.div key={`${agent.agent}:${session.id}`}
        initial={{ opacity: reduced ? 1 : 0, x: reduced ? 0 : 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        <ActivityTimeline resizable={!dockRect} titleId={taskTitleId} agent={agent.agent} session={session} expanded={expanded} onToggleWidth={onToggleWidth} onBack={() => selectAgentPanel({ type: "back" })} />
      </motion.div></ViewStack>}
    </ViewStack>
  </Dialog>;
}
