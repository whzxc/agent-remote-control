import { useState } from 'react';
import { Link } from 'lucide-react';
import type { ProviderAccount as Account } from '../types';
import { accountsApi } from '../api';
import { t } from '../i18n';
import { copyText } from '../platform';
import { sourceDate } from '../sourcePresentation';
import { boundNotificationSessions, refreshAccounts } from '../state/accounts';
import { Button, Dialog, Field, Icon, Notice, Status, Tag } from './ui';
import { Sensitive, SensitiveInput, useSensitiveText } from './Sensitive';
import AgentQuota from './AgentQuota';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
export function PlatformAccountCard({ account, onOpen, onSelect }: { account: Account; onOpen: () => void; onSelect?: () => void }) {
  return <section className="account-card" aria-label={account.alias}>
    <div className="source-section-heading">
      <div className="actions"><h3>{onSelect ? <Button variant="link" onClick={onSelect}>{account.alias}</Button> : account.alias}</h3>{account.plan && <Tag>{account.plan}</Tag>}</div>
      <Button variant="link" onClick={onOpen}>{t('accounts.openAccount')}</Button>
    </div>
    <Sensitive wrap>{account.email}</Sensitive>
    <AccountQuota account={account} />
  </section>;
}
export function AccountSharedNotice() {
  return <div className="account-shared-notice" role="note"><Icon icon={Link} /><span>{t('accounts.sharedQuota')}</span></div>;
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
export function AccountNotifications({ account }: { account: Account }) {
  const [manual, setManual] = useState(false), [target, setTarget] = useState(''), [error, setError] = useState(''), [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false), [sent, setSent] = useState('');
  const sessions = boundNotificationSessions(account);
  const protect = useSensitiveText([target, ...sessions.map(session => session.target)]);
  async function action(work: () => Promise<unknown>) {
    setBusy(true); setError(''); try { await work(); await refreshAccounts(); } catch (e) { setError(String(e)); } finally { setBusy(false); }
  }
  const canNotify = account.agentProfiles.some(profile => profile.agent === 'claude') && !account.removedAt;
  return <section className="account-card">
    <div className="source-section-heading"><h3>{t('accounts.notifications')}</h3><Status tone={account.notifications.state === 'verified' ? 'success' : account.notifications.state === 'not-bound' ? 'warning' : 'neutral'}>{t(`accounts.notifications.${account.notifications.state}`)}</Status></div>
    {account.notifications.state === 'mcp-events' && <p role="status">{t(account.notifications.reachable ? 'accounts.reachable' : 'accounts.unreachable')}</p>}
    {sessions.length > 0 && <ul className="account-sessions" aria-label={t('accounts.sessions')}>{sessions.map((session, index) => {
      const state = session.verified ? 'verified' : session.state;
      const reachable = state === 'verified' || state === 'reachable';
      const known = ['verified', 'reachable', 'unavailable', 'failed', 'not-bound'].includes(state);
      return <li className="account-session" key={`${session.sourceId ?? ''}:${session.target}:${index}`}>
        <div className="source-section-heading"><Sensitive>{session.target}</Sensitive><Status tone={reachable ? 'success' : 'warning'}>{t(`accounts.session.${known ? state : 'unverified'}`)}</Status></div>
        <span className="muted small">{t('accounts.lastDelivery', { time: sourceDate(session.lastDelivery?.at) })}{session.lastDelivery && ` · ${session.lastDelivery.status}`}</span>
        {canNotify && session.channel !== 'mcp-events' && <Button variant="link" disabled={busy} onClick={() => void action(async () => { setSent(''); await accountsApi.notify(account.id, 'test', { target: session.target }); setSent(session.target); })}>{t('accounts.sendTest')}</Button>}
      </li>;
    })}</ul>}
    <div className="actions account-actions">
      {account.provider === 'anthropic' && account.sources.length > 0 && <Button variant="link" disabled={busy} onClick={() => void action(() => copyText(`Use whoami to confirm account ${account.id}, then use notify_control to bind this session and verify notification reachability.`))}>{t('accounts.copyBind')}</Button>}
      {canNotify && <Button variant="link" disabled={busy} onClick={() => { setError(''); setManual(true); }}>{t('accounts.bindManually')}</Button>}
    </div>
    {sent && <p role="status">{t('accounts.testSent')} <Sensitive>{sent}</Sensitive></p>}{error && !manual && <Notice>{protect(error)}</Notice>}
    {manual && <Dialog centered title={t('accounts.bindManually')} busy={busy} onClose={() => setManual(false)} footer={<><Button onClick={() => setManual(false)} disabled={busy}>{t('cancel')}</Button><Button variant="primary" type="submit" form="account-bind" busy={busy}>{t('save')}</Button></>}>
      <form id="account-bind" onSubmit={e => { e.preventDefault(); if (!target.trim()) { setFieldError(t('fieldRequired')); document.getElementById('account-bind-target')?.focus(); return; } void action(async () => { await accountsApi.route({ accountId: account.id, target: target.trim() }); setManual(false); }); }}>
        <p>{t('accounts.bindConsequence')}</p>
        <Field id="account-bind-target" label={t('claudeAccounts.target')} error={fieldError}><SensitiveInput id="account-bind-target" autoComplete="off" value={target} disabled={busy} aria-invalid={!!fieldError} aria-describedby={fieldError ? 'account-bind-target-error' : undefined} onChange={e => { setTarget(e.target.value); setFieldError(''); }} /></Field>
        {error && <Notice>{protect(error)}</Notice>}
      </form>
    </Dialog>}
  </section>;
}
