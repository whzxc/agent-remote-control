import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { accountsApi } from '../api';
import type { ProviderAccount as Account, AccountLogin } from '../types';
import { t } from '../i18n';
import { accounts, refreshAccounts, useAccounts, isUnidentified } from '../state/accounts';
import { connector } from '../state/connector';
import { subscriptions } from '../state/subscriptions';
import { accountPlatform, accountOwns } from '../accountPresentation';
import { name as agentName } from '../state/agents';
import { sourceDate } from '../sourcePresentation';
import { navigation } from '../state/navigation';
import { openOnboarding } from '../state/onboarding';
import { Button, Dialog, Empty, Field, HoverScope, Icon, Input, Notice, Status, Switch, Tag } from './ui';
import { Sensitive, SensitiveIdentity } from './Sensitive';
import { AccountNotifications, AccountQuota, AccountSharedNotice } from './AccountCards';
import AddAccount from './AddAccount';
import { openSourceWorkspace } from './SourcePanel';
import AccountAvatar from './AccountAvatar';
import MergeAccounts from './MergeAccounts';

export function AccountsActions() {
  const { items } = accounts.use();
  return <><span className="muted small">{t('accounts.count', { count: items.length })}</span><Button variant="primary" onClick={() => navigation.set(old => ({ ...old, addAccount: true }))}>{t('accounts.add')}</Button></>;
}
export default function AccountsPage() {
  const state = useAccounts(), nav = navigation.use();
  const { sources } = connector.use(), { snapshot } = subscriptions.use();
  const [selected, setSelected] = useState<string>();
  const account = state.items.find(a => accountOwns(a, nav.accountId ?? selected)) ?? state.items[0];
  const [login, setLogin] = useState<AccountLogin>();
  const [roleAccount, setRoleAccount] = useState<Account>();
  const groups = new Map<string, { label: string; accounts: Account[] }>();
  for (const item of state.items) {
    const platform = accountPlatform(item, sources, snapshot?.providers ?? []);
    const group = groups.get(platform.id) ?? { label: platform.label, accounts: [] };
    group.accounts.push(item); groups.set(platform.id, group);
  }
  return <div className="accounts-workspace">
    {state.error && <Notice action={<Button onClick={() => void refreshAccounts()}>{t('retry')}</Button>}>{state.error}</Notice>}
    {state.loading && <p role="status">{t('loading')}</p>}
    {!state.loading && !state.error && !state.items.length && <Empty>{t('accounts.empty')}</Empty>}
    <div className="accounts-columns">
      <nav className="account-list" aria-label={t('accounts.title')}><HoverScope>{[...groups].map(([provider, group]) => {
        return <section key={provider}><h3>{group.label}</h3>{group.accounts.map(row => <Button key={row.id} variant="ghost" className="account-list-row" data-hover-target={row.id} aria-current={account?.id === row.id ? 'true' : undefined} onClick={() => { setSelected(row.id); navigation.set(old => ({ ...old, accountId: undefined })); }}>
          <AccountAvatar account={row} /><span className="account-row-copy"><strong>{row.alias}</strong>{row.email && <Sensitive>{row.email}</Sensitive>}<span className="account-roles">{!!row.sources.length && <Tag tone="source">SRC</Tag>}{!!row.agentProfiles.length && <Tag tone="agent">AGENT</Tag>}</span></span>
          {(row.notifications.state === 'not-bound' || row.agentProfiles.some(p => p.state !== 'signed-in')) && <span className="account-warning" role="img" aria-label={t('accounts.attention')} />}
        </Button>)}</section>;
      })}</HoverScope></nav>
      {account && <AccountDetail key={account.id} account={account} onLogin={setLogin} onAdd={() => setRoleAccount(account)} />}
    </div>
    {(nav.addAccount || login || roleAccount) && <AddAccount forAccount={roleAccount} initialLogin={login ?? (!roleAccount && state.login && ['starting', 'waiting'].includes(state.login.state) ? state.login : undefined)} onClose={() => { setLogin(undefined); setRoleAccount(undefined); navigation.set(old => ({ ...old, addAccount: false })); }} />}
  </div>;
}
function AccountDetail({ account, onLogin, onAdd }: { account: Account; onLogin: (login: AccountLogin) => void; onAdd: () => void }) {
  const { sources, status } = connector.use();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), [remove, setRemove] = useState(false);
  const [merging, setMerging] = useState(false);
  async function action(work: () => Promise<unknown>) { setBusy(true); setError(''); try { await work(); await refreshAccounts(); return true; } catch (e) { setError(String(e)); return false; } finally { setBusy(false); } }
  return <div className="account-detail">
    <header className="account-detail-header">
      <AccountAvatar account={account} />
      <div className="account-detail-identity">
        <AccountAlias account={account} busy={busy} onSave={alias => action(() => accountsApi.update({ id: account.id, alias }))} />
        <div className="account-detail-meta"><SensitiveIdentity email={account.email} orgName={account.orgName} />{account.plan && <>{(account.email || account.orgName) && <span aria-hidden="true"> · </span>}<Tag>{account.plan}</Tag></>}</div>
      </div>
      <Button variant="ghost" onClick={() => setMerging(true)}>{t('accounts.merge')}</Button>
    </header>
    {isUnidentified(account) && <p className="muted">{t(account.sources.length ? 'accounts.unidentified' : 'accounts.nativeAuth')}</p>}
    {error && !remove && <Notice>{error}</Notice>}
    <h3>{t('accounts.where')}</h3><div className="account-role-cards">
      <section className="account-card"><h3>{t('accounts.controlSource')}</h3>{account.sources.length ? account.sources.map(id => {
        const source = sources.find(s => s.id === id), ingress = status?.ingresses.find(i => i.id === source?.ingressId);
        return <div key={id} className="account-connection"><strong>{source?.label ?? id}</strong><Status tone={source?.state === 'connected' ? 'success' : 'neutral'}>{source ? t(`source.state.${source.state}`) : '—'}</Status><span className="muted small">{ingress?.name ?? source?.connectionName}</span><span className="muted small">{t('source.lastSeen')}: {sourceDate(source?.lastSeenAt)}</span><Button variant="link" disabled={!source} onClick={() => openSourceWorkspace(id)}>{t('accounts.openSource')}</Button></div>;
      }) : <><p className="muted">{t('accounts.noSource')}</p><Button variant="link" onClick={() => { navigation.set(old => ({ ...old, page: 'overview' })); openOnboarding(); }}>{t('addControlSource')}</Button></>}</section>
      <section className="account-card"><h3>Agent</h3>{account.agentProfiles.length ? account.agentProfiles.map(profile => <div key={profile.profileId} className="account-profile"><div className="source-section-heading"><strong>{agentName(profile)}</strong><Status tone={profile.state === 'signed-in' ? 'success' : 'warning'}>{t(`accounts.profile.${profile.state}`)}</Status></div><span className="muted small">{profile.kind}</span><div className="source-section-heading"><span>{t('accounts.default')}</span><Switch label={`${agentName(profile)} · ${t('accounts.default')}`} checked={profile.default} disabled={busy || profile.default || profile.state !== 'signed-in'} onChange={() => void action(() => accountsApi.update({ id: account.id, defaultFor: profile.agent }))} /></div>{['claude', 'codex'].includes(profile.agent) ? <Button variant="link" disabled={busy} onClick={() => void action(async () => onLogin(await accountsApi.reauth({ id: account.id, agent: profile.agent })))}>{t('accounts.reauth')}</Button> : <p className="muted">{t('accounts.nativeAuth')}</p>}</div>) : <><p className="muted">{t('accounts.noAgent')}</p><Button variant="link" onClick={onAdd}>{t('accounts.addAgent')}</Button></>}</section>
    </div>
    {!!account.sources.length && !!account.agentProfiles.length && <AccountSharedNotice />}
    <AccountQuota account={account} /><AccountNotifications account={account} />
    <div className="account-remove"><p className="muted">{t('accounts.removeConsequence')}</p><Button variant="danger-outline" disabled={busy} onClick={() => setRemove(true)}>{t('remove')}</Button></div>
    {remove && <Dialog centered title={t('accounts.removeTitle', { alias: account.alias })} busy={busy} onClose={() => setRemove(false)} footer={<><Button disabled={busy} onClick={() => setRemove(false)}>{t('cancel')}</Button><Button variant="danger" busy={busy} onClick={() => void action(() => accountsApi.remove({ id: account.id, running: 'finish' }))}>{t('remove')}</Button></>}><p>{t('accounts.removeConsequence')}</p>{error && <Notice>{error}</Notice>}</Dialog>}
    {merging && <MergeAccounts account={account} onClose={() => setMerging(false)} />}
  </div>;
}

function AccountAlias({ account, busy, onSave }: { account: Account; busy: boolean; onSave: (alias: string) => Promise<boolean> }) {
  const [editing, setEditing] = useState(false), [alias, setAlias] = useState(account.alias), [error, setError] = useState('');
  const active = useRef(false), saving = useRef(false), restoreFocus = useRef(false), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (!editing && restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); } }, [editing]);
  function finish(returnFocus: boolean) { active.current = false; restoreFocus.current = returnFocus; setEditing(false); }
  async function save(returnFocus: boolean) {
    if (!active.current || saving.current) return;
    const value = alias.trim();
    if (!value) { setError(t('fieldRequired')); document.getElementById('account-detail-alias')?.focus(); return; }
    saving.current = true;
    try { if (value === account.alias || await onSave(value)) finish(returnFocus); }
    finally { saving.current = false; }
  }
  return editing ? <form className="account-alias-editor" onSubmit={event => { event.preventDefault(); void save(true); }}>
    <Field id="account-detail-alias" label={<span className="sr-only">{t('accounts.alias')}</span>} error={error}>
      <Input id="account-detail-alias" autoFocus value={alias} disabled={busy} aria-invalid={!!error} aria-describedby={error ? 'account-detail-alias-error' : undefined}
        onFocus={event => event.currentTarget.select()} onChange={event => { setAlias(event.target.value); setError(''); }} onBlur={() => void save(false)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Enter') { event.preventDefault(); void save(true); }
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); finish(true); }
        }} />
    </Field>
  </form> : <h2><Button ref={trigger} variant="ghost" className="account-alias-trigger" disabled={busy} aria-label={t('accounts.editAlias', { alias: account.alias })}
    onClick={() => { active.current = true; setAlias(account.alias); setError(''); setEditing(true); }}>{account.alias}<Icon icon={Pencil} /></Button></h2>;
}
