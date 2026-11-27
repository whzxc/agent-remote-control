import { useEffect, useId, useState, type FormEvent } from 'react';
import { accountsApi } from '../api';
import { t } from '../i18n';
import { refreshAccounts, refreshAccountQuota } from '../state/accounts';
import type { AccountLogin, ProviderAccount } from '../types';
import { copyText } from '../platform';
import { SetupAccountDialog } from './accounts/SetupAccountDialog';
import { useSubmittedDirty } from './ui/useSubmittedDirty';
import { useDialogCompletion } from './ui/Dialog';
import { AgentAccountFooterView, AgentAccountFormView } from './AgentAccountDialogView';
import './AgentAccountAdd.css';

export default function AgentAccountAdd({ kind, account, onClose }: {
  kind: 'claude'; account?: ProviderAccount; onClose: () => void;
}) {
  const completion = useDialogCompletion(onClose);
  const title = account ? t('accountAdd.reauthTitle', { alias: account.alias }) : t('accountAdd.claudeTitle');
  const id = useId();
  const [browsers, setBrowsers] = useState<Array<{ id: string; name: string }>>([]), [browser, setBrowser] = useState('default');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [code, setCode] = useState(''), [submitted, setSubmitted] = useState(false);
  const values = { code, browser };
  const draft = useSubmittedDirty(values, !!code || browser !== 'default');
  const active = login?.state === 'starting' || login?.state === 'waiting';
  const expired = login?.state === 'failed' && !!login.error?.startsWith('CLAUDE_LOGIN_TIMEOUT');

  useEffect(() => {
    void accountsApi.browsers().then(v => setBrowsers(v.browsers)).catch(e => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!active || !login) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await accountsApi.list();
        if (stopped) {
          if (result.login?.loginId === login.loginId && result.login.state === 'completed') completion.feedback(`${title} · ${t('accounts.login.completed')}`);
          return;
        }
        if (result.login?.loginId === login.loginId) {
          if (result.login.state === 'completed') {
            await refreshAccounts(true);
            if (!stopped) {
              setLogin(result.login); void completion.finish();
              if (result.login.accountId) void refreshAccountQuota(result.login.accountId).catch(() => {});
            }
            return;
          }
          setLogin(result.login);
          if (result.login.state === 'failed' || result.login.state === 'cancelled') return;
        } else {
          setError(t('accounts.loginChanged'));
          setLogin(null);
          return;
        }
      } catch (e) { if (!stopped) setError(String(e)); }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [active, login?.loginId, account?.id, onClose]);

  async function cancelLogin() {
    if (!active || !login) return true;
    try { await accountsApi.login({ loginId: login.loginId, action: 'cancel' }); setLogin(null); return true; }
    catch (err) { setError(String(err)); return false; }
  }

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    draft.submit(); setBusy(true);
    try {
      if (active && login) {
        if (code.trim()) {
          await accountsApi.login({ loginId: login.loginId, action: 'code', code: code.trim() });
          draft.submit({ ...values, code: '' }); setCode(''); setSubmitted(true);
        }
      } else {
        setSubmitted(false);
        const result = account
          ? await accountsApi.reauth({ id: account.id, agent: kind, browserId: browser })
          : await accountsApi.add({ kind, browserId: browser });
        if (result.state === 'completed') {
          await refreshAccounts(true); await completion.finish();
          if (result.accountId) void refreshAccountQuota(result.accountId).catch(() => {});
        } else {
          setLogin(result);
          if (result.browserError) setError(result.browserError);
        }
      }
    } catch (e) { setError(String(e)); completion.feedback(String(e), true); }
    finally { setBusy(false); }
  }

  const codeEntry = active && login?.state === 'waiting' && !submitted;
  const loginError = login?.state === 'failed' ? expired ? t('accountAdd.expired') : login.error ?? t('accountAdd.loginFailed') : undefined;
  const notice = error || loginError || login?.browserError;
  const waitingBrowser = login?.browserName ?? browsers.find(option => option.id === login?.browserId)?.name;
  const waitingStatus = [
    t(login?.state === 'starting' ? 'accounts.login.starting' : 'accountAdd.waitingBrowser'),
    waitingBrowser,
  ].filter(Boolean).join(' · ');
  const focusTarget = account ? `[data-account-reauth="${CSS.escape(account.id)}"], [data-add-agent-account]` : '[data-add-agent-account]';
  const browserOptions = [
    { value: 'default', label: t('accountAdd.defaultBrowser') },
    ...browsers.map(b => ({ value: b.id, label: b.name })),
  ];

  return (
    <SetupAccountDialog
      layerId={completion.layerId}
      title={title}
      busy={busy || active}
      dirty={draft.dirty}
      onCancel={active ? cancelLogin : undefined}
      onClose={onClose}
      returnFocus={focusTarget}
      footer={
        <AgentAccountFooterView
          formId={`${id}-form`}
          active={active}
          codeEntry={codeEntry}
          busy={busy}
          canCopyLink={Boolean(login?.loginUrl)}
          copyLinkLabel={t('accountAdd.copyLink')}
          onCopyLink={() => void copyText(login!.loginUrl!).catch(err => setError(String(err)))}
          submitCodeLabel={t('accountAdd.submitCode')}
          submitCodeDisabled={!code.trim()}
          primaryLabel={t(login?.state === 'failed' ? 'accountAdd.retry' : 'accountAdd.login')}
        />
      }
    >
      <AgentAccountFormView
        formId={`${id}-form`}
        codeId={`${id}-code`}
        active={active}
        expired={expired}
        codeEntry={codeEntry}
        busy={busy}
        notice={notice || undefined}
        waitingStatus={waitingStatus}
        codeLabel={t('accountAdd.authorizationCode')}
        codePlaceholder={t('accountAdd.codePlaceholder')}
        code={code}
        onCodeChange={setCode}
        browserLabel={t('accountAdd.browser')}
        browserValue={browser}
        browserOptions={browserOptions}
        onBrowserChange={setBrowser}
        onSubmit={event => void submit(event)}
      />
    </SetupAccountDialog>
  );
}
