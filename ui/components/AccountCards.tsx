import { useId, useState, type FormEvent } from 'react';
import { accountsApi } from '../api';
import type { AccountAgentProfile, ProviderAccount as Account } from '../types';
import { refreshAccounts, refreshAccountQuota } from '../state/accounts';
import { readOnlyBrowser } from '../browserMode';
import { t } from '../i18n';
import { Button } from './kit/button';
import Dialog, { useDialogCompletion } from './ui/Dialog';
import { EntityCard } from './ui/EntityInventory';
import { useSubmittedDirty } from './ui/useSubmittedDirty';
import { Sensitive } from './Sensitive';
import AgentQuota from './AgentQuota';
import { accountQuotaProvider } from '../subscriptions/accountQuota';
import { AccountCardView, EditAccountAliasFormView, RemoveAccountFormView } from './AccountCardView';

export function AgentAccountCard({ account, profile, onSelect, onReauth }: {
  account: Account; profile: AccountAgentProfile; onSelect: () => void; onReauth?: () => void;
}) {
  const [refreshing, setRefreshing] = useState(false), [error, setError] = useState('');
  const [editing, setEditing] = useState<'alias' | 'remove'>();
  const id = useId();
  const provider = accountQuotaProvider(profile.agent, account.quota);
  const signedIn = profile.state === 'signed-in';
  const canRemove = account.agentProfiles.length === 1 && !account.sources.length;

  async function refresh() {
    setRefreshing(true); setError('');
    try { await refreshAccountQuota(account.id); }
    catch (err) { setError(String(err)); }
    finally { setRefreshing(false); }
  }

  return (
    <>
      <AccountCardView
        CardWrapper={EntityCard}
        accountId={account.id}
        alias={account.alias}
        emailNode={account.email ? <Sensitive>{account.email}</Sensitive> : undefined}
        isDefault={profile.default}
        defaultLabel={t('accounts.defaultBadge')}
        signedIn={signedIn}
        readOnly={readOnlyBrowser}
        canRemove={canRemove}
        refreshing={refreshing}
        error={error || undefined}
        editButtonId={`${id}-alias`}
        removeButtonId={`${id}-remove`}
        editLabel={t('accounts.editAliasAction')}
        refreshLabel={t('usageRefresh')}
        removeLabel={t('accounts.removeAction')}
        statusLabel={t(signedIn ? 'accounts.quotaUnavailable' : profile.state === 'signed-out' ? 'accounts.agentSignedOut' : `accounts.profile.${profile.state}`)}
        reauthLabel={profile.state === 'signed-out' && onReauth ? t('accounts.reauth') : undefined}
        quotaSlot={signedIn && provider.windows.length > 0 ? <AgentQuota provider={provider} /> : undefined}
        onSelect={onSelect}
        onEdit={() => setEditing('alias')}
        onRefresh={() => void refresh()}
        onRemove={() => setEditing('remove')}
        onReauth={onReauth}
      />
      {editing && (
        <AccountEdit
          account={account}
          profile={profile}
          action={editing}
          returnFocus={`[id="${id}-${editing}"], [data-add-agent-account]`}
          onClose={() => setEditing(undefined)}
        />
      )}
    </>
  );
}

function AccountEdit({ account, profile, action, returnFocus, onClose }: {
  account: Account; profile: AccountAgentProfile; action: 'alias' | 'remove'; returnFocus: string; onClose: () => void;
}) {
  const id = useId();
  const [alias, setAlias] = useState(account.alias), [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const removing = action === 'remove';
  const completion = useDialogCompletion(onClose);
  const draft = useSubmittedDirty(alias, !removing && alias !== account.alias);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!removing && !alias.trim()) {
      setInvalid(true);
      document.getElementById(id)?.focus();
      return;
    }
    draft.submit(); setBusy(true); setError('');
    try {
      if (removing) await accountsApi.remove({ id: account.id, agent: profile.agent, running: 'finish' });
      else await accountsApi.update({ id: account.id, alias: alias.trim() });
      await completion.finish();
      // Let the dialog restore focus before removing its trigger from the list.
      void refreshAccounts(true);
    } catch (err) { setError(String(err)); } finally { setBusy(false); }
  }

  return (
    <Dialog
      layerId={completion.layerId}
      title={removing ? t('accounts.removeTitle', { alias: account.alias }) : t('accounts.editAliasAction')}
      className="agent-account-add"
      initialFocus={removing ? undefined : id}
      dirty={!removing && draft.dirty}
      busy={busy}
      returnFocus={returnFocus}
      onClose={onClose}
      footer={
        <Button form={`${id}-form`} type="submit" variant={removing ? 'danger' : 'primary'} busy={busy}>
          {t(removing ? 'accounts.removeAction' : 'save')}
        </Button>
      }
    >
      {removing ? (
        <RemoveAccountFormView
          formId={`${id}-form`}
          consequence={t('accounts.removeAgentConsequence')}
          error={error || undefined}
          onSubmit={event => void submit(event)}
        />
      ) : (
        <EditAccountAliasFormView
          formId={`${id}-form`}
          inputId={id}
          aliasLabel={t('accounts.alias')}
          alias={alias}
          invalidError={invalid ? t('accounts.aliasRequired') : undefined}
          error={error || undefined}
          onAliasChange={value => { setAlias(value); setInvalid(false); }}
          onSubmit={event => void submit(event)}
        />
      )}
    </Dialog>
  );
}
