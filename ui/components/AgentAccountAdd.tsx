import { SetupAccountDialog } from "./accounts/SetupAccountDialog";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";
import { useDialogCompletion } from "./ui/Dialog";
import { useEffect, useId, useState, type FormEvent } from 'react';
import { accountsApi } from '../api';
import { t } from '../i18n';
import { refreshAccounts, refreshAccountQuota } from '../state/accounts';
import type { AccountLogin, ProviderAccount } from '../types';
import { Button, Field, Input, Notice, SingleChoice } from './ui';
import { copyText } from '../platform';
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
  const draft = useSubmittedDirty(values, !!code || browser !== "default");
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
          if (result.login.state === 'failed') return;
          if (result.login.state === 'cancelled') return;
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
    catch (error) { setError(String(error)); return false; }
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
  const focusTarget = account ? `[data-account-reauth="${CSS.escape(account.id)}"], [data-add-agent-account]` : '[data-add-agent-account]';
  return <SetupAccountDialog layerId={completion.layerId} title={title} busy={busy || active}
    dirty={draft.dirty}
    onCancel={active ? cancelLogin : undefined}
    onClose={onClose} returnFocus={focusTarget} footer={<div className="actions">
    {active && login?.loginUrl && <Button onClick={() => void copyText(login.loginUrl!).catch(error => setError(String(error)))}>{t('accountAdd.copyLink')}</Button>}
    {codeEntry && <Button form={`${id}-form`} type="submit" variant="primary" busy={busy} disabled={!code.trim()}>{t('accountAdd.submitCode')}</Button>}
    {!active && <Button form={`${id}-form`} type="submit" variant="primary" busy={busy}>
      {t(login?.state === 'failed' ? 'accountAdd.retry' : 'accountAdd.login')}
    </Button>}
  </div>}>
    <form id={`${id}-form`} className="agent-account-add-form" data-waiting={active || undefined} onSubmit={event => void submit(event)}>
      {notice && <Notice tone="danger">{notice}</Notice>}
      {active ? <>
        <p role="status" className="account-login-status">{[
          t(login?.state === 'starting' ? 'accounts.login.starting' : 'accountAdd.waitingBrowser'),
          waitingBrowser,
        ].filter(Boolean).join(' · ')}</p>
        {codeEntry && <Field id={id + '-code'} label={t('accountAdd.authorizationCode')}>
          <Input id={id + '-code'} value={code} onChange={event => setCode(event.target.value)}
            placeholder={t('accountAdd.codePlaceholder')} autoComplete="off" spellCheck={false} />
        </Field>}
      </> : !expired && <Field label={t('accountAdd.browser')}><SingleChoice label={t('accountAdd.browser')} value={browser} onChange={setBrowser} disabled={busy} dropdown fill options={[
        { value: 'default', label: t('accountAdd.defaultBrowser') }, ...browsers.map(b => ({ value: b.id, label: b.name })),
      ]} /></Field>}
    </form>
  </SetupAccountDialog>;
}
