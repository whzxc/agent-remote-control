import { useDialogCompletion } from "./ui/Dialog";
import { useId, useState, type FormEvent } from 'react';
import { Pencil, RefreshCw, Trash2 } from 'lucide-react';
import { accountsApi } from '../api';
import type { AccountAgentProfile, ProviderAccount as Account } from '../types';
import { refreshAccounts, refreshAccountQuota } from '../state/accounts';
import { readOnlyBrowser } from '../browserMode';
import { t } from '../i18n';
import { Button, Dialog, Field, IconButton, Input, Notice, Tag } from './ui';
import { Card } from './ui/card';
import { Sensitive } from './Sensitive';
import AgentQuota from './AgentQuota';
import { accountQuotaProvider } from '../subscriptions/accountQuota';

export function AgentAccountCard({ account, profile, onSelect, onReauth }: {
  account: Account; profile: AccountAgentProfile; onSelect: () => void; onReauth?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<'alias' | 'remove'>();
  const id = useId();
  const provider = accountQuotaProvider(profile.agent, account.quota);
  const signedIn = profile.state === 'signed-in';
  const canRemove = profile.kind !== 'api-key' && profile.profileId !== 'codex-home' && account.agentProfiles.length === 1 && !account.sources.length;
  async function refresh() {
    setRefreshing(true); setError('');
    try { await refreshAccountQuota(account.id); }
    catch (error) { setError(String(error)); }
    finally { setRefreshing(false); }
  }
  return <Card variant="reply" className="account-card" role="region" aria-label={account.alias}>
    <div className="account-heading">
      <div className="account-identity">
        <div className="account-name">
          <h3><Button variant="link" onClick={onSelect}><span>{account.alias}</span></Button></h3>
          {profile.default && <Tag>{t('accounts.defaultBadge')}</Tag>}
        </div>
        {account.email && <div className="account-email"><Sensitive>{account.email}</Sensitive></div>}
      </div>
      {!readOnlyBrowser && <div className="actions">
        <IconButton id={id + '-alias'} compact icon={Pencil} label={t('accounts.editAliasAction')} onClick={() => setEditing('alias')} />
        {signedIn && <IconButton compact icon={RefreshCw} label={t('usageRefresh')} busy={refreshing} onClick={() => void refresh()} />}
        {canRemove && <IconButton id={id + '-remove'} compact icon={Trash2} label={t('accounts.removeAction')} onClick={() => setEditing('remove')} />}
      </div>}
    </div>
    {error && <Notice tone="danger">{error}</Notice>}
    {signedIn && provider.windows.length > 0 ? <AgentQuota provider={provider} /> :
      <div className="account-status">
        <span data-signed-out={!signedIn || undefined}>{t(signedIn ? 'accounts.quotaUnavailable' : profile.state === 'signed-out' ? 'accounts.agentSignedOut' : `accounts.profile.${profile.state}`)}</span>
        {profile.state === 'signed-out' && onReauth && <Button data-account-reauth={account.id} onClick={onReauth}>{t('accounts.reauth')}</Button>}
      </div>}
    {editing && <AccountEdit account={account} profile={profile} action={editing}
      returnFocus={`[id="${id}-${editing}"], [data-add-agent-account]`} onClose={() => setEditing(undefined)} />}
  </Card>;
}

function AccountEdit({ account, profile, action, returnFocus, onClose }: {
  account: Account; profile: AccountAgentProfile; action: 'alias' | 'remove'; returnFocus: string; onClose: () => void;
}) {
  const id = useId();
  const [alias, setAlias] = useState(account.alias), [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const removing = action === 'remove';
  const completion = useDialogCompletion(onClose);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!removing && !alias.trim()) {
      setInvalid(true);
      document.getElementById(id)?.focus();
      return;
    }
    setBusy(true); setError('');
    try {
      if (removing) await accountsApi.remove({ id: account.id, agent: profile.agent, running: 'finish' });
      else await accountsApi.update({ id: account.id, alias: alias.trim() });
      await completion.finish();
      // Let the dialog restore focus before removing its trigger from the list.
      void refreshAccounts(true);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <Dialog layerId={completion.layerId} size="s" title={removing ? t('accounts.removeTitle', { alias: account.alias }) : t('accounts.editAliasAction')}
    className="agent-account-add" initialFocus={removing ? undefined : id} dirty={!removing && alias !== account.alias} busy={busy} returnFocus={returnFocus} onClose={onClose}
    footer={<Button form={id + '-form'} type="submit" variant={removing ? 'danger' : 'primary'} busy={busy}>
      {t(removing ? 'accounts.removeAction' : 'save')}
    </Button>}>
    <form id={id + '-form'} className="agent-account-add-form" onSubmit={event => void submit(event)}>
      {error && <Notice tone="danger">{error}</Notice>}
      {removing ? <p className="account-removal">{t('accounts.removeAgentConsequence')}</p> :
        <Field id={id} label={t('accounts.alias')} error={invalid ? t('accounts.aliasRequired') : undefined}>
          <Input id={id} value={alias} onChange={event => { setAlias(event.target.value); setInvalid(false); }}
            aria-invalid={invalid || undefined} aria-describedby={invalid ? id + '-error' : undefined} />
        </Field>}
    </form>
  </Dialog>;
}
