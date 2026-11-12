import { useDialogCompletion } from "./ui/Dialog";
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountsApi, api } from '../api';
import { t } from '../i18n';
import { refreshAccounts, refreshAccountQuota } from '../state/accounts';
import type { AccountLogin, CodexAccountImport, ProviderAccount } from '../types';
import { Button, Dialog, Field, Input, Notice, SingleChoice, Textarea } from './ui';
import { copyText } from '../platform';
import './AgentAccountAdd.css';

type Method = 'oauth' | 'import';
type Owner = CodexAccountImport['refreshOwner'];
type Errors = Partial<Record<'auth' | 'program' | 'args', string>>;

export default function AgentAccountAdd({ kind, account, onClose }: {
  kind: 'codex' | 'claude'; account?: ProviderAccount; onClose: () => void;
}) {
  const completion = useDialogCompletion(onClose);
  const profile = account?.agentProfiles.find(p => p.agent === kind);
  const desktop = profile?.profileId === 'codex-home';
  const importOnly = profile?.refreshOwner === 'none';
  const external = profile?.refreshOwner === 'external';
  const useBrowser = !desktop && !external;
  const title = account ? t('accountAdd.reauthTitle', { alias: account.alias })
    : t(kind === 'claude' ? 'accountAdd.claudeTitle' : 'accountAdd.title');
  const id = useId();
  const [method, setMethod] = useState<Method>(importOnly ? 'import' : 'oauth'), [owner, setOwner] = useState<Owner>(importOnly ? 'none' : 'codex');
  const [auth, setAuth] = useState(''), [program, setProgram] = useState(''), [args, setArgs] = useState('');
  const [browsers, setBrowsers] = useState<Array<{ id: string; name: string }>>([]), [browser, setBrowser] = useState('default');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [errors, setErrors] = useState<Errors>({});
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const [code, setCode] = useState(''), [submitted, setSubmitted] = useState(false);
  const closing = useRef(false);
  const active = login?.state === 'starting' || login?.state === 'waiting';
  const expired = login?.state === 'failed' && !!login.error?.startsWith('CLAUDE_LOGIN_TIMEOUT');
  useEffect(() => {
    if (useBrowser && !importOnly) void accountsApi.browsers().then(v => setBrowsers(v.browsers)).catch(e => setError(String(e)));
  }, [useBrowser, importOnly]);
  useEffect(() => {
    if (!active || !login) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await accountsApi.list();
        if (stopped) return;
        if (desktop) {
          const primary = result.accounts.find(row => row.agentProfiles.some(p => p.profileId === 'codex-home' && p.state === 'signed-in'));
          if (primary) {
            await refreshAccounts(true);
            if (!stopped) { setLogin({ ...login, state: "completed" }); void completion.finish(); void refreshAccountQuota(primary.id).catch(() => {}); }
            return;
          }
        } else if (result.login?.loginId === login.loginId) {
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
  }, [active, login?.loginId, desktop, account?.id, onClose]);
  async function cancelLogin() {
    if (!active || !login || desktop) return true;
    try { await accountsApi.login({ loginId: login.loginId, action: 'cancel' }); setLogin(null); return true; }
    catch (error) { setError(String(error)); return false; }
  }
  async function close() {
    if (closing.current) return;
    closing.current = true;
    if (await cancelLogin()) onClose();
    else closing.current = false;
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setErrors({});
    let credentials: Record<string, unknown> = {}, arguments_: string[] = [];
    const invalid: Errors = {};
    if (method === 'import') {
      try { const value = JSON.parse(auth); if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error(); credentials = value; }
      catch { invalid.auth = t('accountAdd.invalidAuth'); }
      if (owner === 'external') {
        if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(program.trim())) invalid.program = t('accountAdd.absoluteProgram');
        try { const value = JSON.parse(args.trim() || '[]'); if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) throw Error(); arguments_ = value; }
        catch { invalid.args = t('accountAdd.invalidArgs'); }
      }
      if (Object.keys(invalid).length) {
        setErrors(invalid); requestAnimationFrame(() => document.getElementById(`${id}-${Object.keys(invalid)[0]}`)?.focus()); return;
      }
    }
    setBusy(true);
    try {
      if (active && login) {
        if (kind === 'claude' && code.trim()) {
          await accountsApi.login({ loginId: login.loginId, action: 'code', code: code.trim() });
          setCode(''); setSubmitted(true);
        }
      } else if (desktop) {
        await api('agents/open', 'POST', { agent: 'codex' });
        setLogin({ loginId: 'desktop', kind, state: 'waiting' });
      } else if (method === 'oauth') {
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
      } else {
        const result = await accountsApi.importCodex({ auth: credentials, accountId: account?.id, refreshOwner: owner, ...(owner === 'external' ? { refreshCommand: { program: program.trim(), args: arguments_ } } : {}) });
        setAuth(''); await refreshAccounts(true); await completion.finish();
        void refreshAccountQuota(result.accountId).catch(() => {});
      }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const codeEntry = active && login?.state === 'waiting' && kind === 'claude' && !submitted;
  const loginError = login?.state === 'failed' ? expired ? t('accountAdd.expired') : login.error ?? t('accountAdd.loginFailed') : undefined;
  const notice = error || loginError || login?.browserError;
  const waitingBrowser = login?.browserName ?? browsers.find(option => option.id === login?.browserId)?.name;
  const focusTarget = account ? `[data-account-reauth="${CSS.escape(account.id)}"], [data-add-agent-account]` : '[data-add-agent-account]';
  return <Dialog layerId={completion.layerId} size="m" title={title} className="agent-account-add" busy={busy || active}
    dirty={!!auth || !!program || !!args || !!code || browser !== "default" || method !== (importOnly ? "import" : "oauth")}
    onCancel={active && !desktop ? cancelLogin : undefined}
    onClose={close} returnFocus={focusTarget} footer={<div className="actions">
    {!account && kind === 'codex' && <Button onClick={() => void close()}>{t('cancel')}</Button>}
    {active && login?.loginUrl && <Button onClick={() => void copyText(login.loginUrl!).catch(error => setError(String(error)))}>{t('accountAdd.copyLink')}</Button>}
    {codeEntry && <Button form={`${id}-form`} type="submit" variant="primary" busy={busy} disabled={!code.trim()}>{t('accountAdd.submitCode')}</Button>}
    {!active && <Button form={`${id}-form`} type="submit" variant="primary" busy={busy}>
      {t(desktop ? 'accountAdd.openCodex' : external ? 'usageRefresh' : method === 'import' ? 'accountAdd.import'
        : login?.state === 'failed' ? 'accountAdd.retry' : 'accountAdd.login')}
    </Button>}
  </div>}>
    <form id={`${id}-form`} className="agent-account-add-form" data-waiting={active || undefined} onSubmit={event => void submit(event)}>
      {notice && <Notice tone="danger">{notice}</Notice>}
      {active ? <>
        <p role="status" className="account-login-status">{[
          t(login?.state === 'starting' ? 'accounts.login.starting' : desktop ? 'accounts.login.waiting' : 'accountAdd.waitingBrowser'),
          waitingBrowser,
        ].filter(Boolean).join(' · ')}</p>
        {codeEntry && <Field id={id + '-code'} label={t('accountAdd.authorizationCode')}>
          <Input id={id + '-code'} value={code} onChange={event => setCode(event.target.value)}
            placeholder={t('accountAdd.codePlaceholder')} autoComplete="off" spellCheck={false} />
        </Field>}
      </> : <>
        {!account && kind === 'codex' && <SingleChoice label={t('accountAdd.method')} value={method}
          onChange={v => setMethod(v as Method)} fill disabled={busy} options={[
            { value: 'oauth', label: t('accountAdd.oauth') }, { value: 'import', label: t('accountAdd.credentials') },
          ]} />}
        {method === 'oauth' ? useBrowser && !expired && <Field label={t('accountAdd.browser')}><SingleChoice label={t('accountAdd.browser')} value={browser} onChange={setBrowser} disabled={busy} dropdown fill options={[
          { value: 'default', label: t('accountAdd.defaultBrowser') }, ...browsers.map(b => ({ value: b.id, label: b.name })),
        ]} /></Field> : <>
          <Field id={`${id}-auth`} label={t('accountAdd.auth')} error={errors.auth}><Textarea id={`${id}-auth`} value={auth} onChange={e => setAuth(e.target.value)} disabled={busy} spellCheck={false} autoComplete="off" rows={5} placeholder={t('accountAdd.authPlaceholder')} aria-invalid={!!errors.auth} aria-describedby={errors.auth ? `${id}-auth-error` : undefined} /></Field>
          {!importOnly && <Field label={t('accountAdd.refresh')}><SingleChoice label={t('accountAdd.refresh')} value={owner} onChange={v => setOwner(v as Owner)} disabled={busy} fill options={[
            { value: 'codex', label: t('accountAdd.codexRefresh') }, { value: 'none', label: t('accountAdd.noRefresh') }, { value: 'external', label: t('accountAdd.external') },
          ]} /></Field>}
          {owner === 'external' && <>
            <Field id={`${id}-program`} label={t('accountAdd.program')} error={errors.program}><Input id={`${id}-program`} value={program} disabled={busy} onChange={e => setProgram(e.target.value)} placeholder={t('accountAdd.programPlaceholder')} aria-invalid={!!errors.program} aria-describedby={errors.program ? `${id}-program-error` : undefined} /></Field>
            <Field id={`${id}-args`} label={t('accountAdd.args')} error={errors.args}><Input id={`${id}-args`} value={args} disabled={busy} onChange={e => setArgs(e.target.value)} placeholder={'["--account", "account-id"]'} aria-invalid={!!errors.args} aria-describedby={errors.args ? `${id}-args-error` : undefined} /></Field>
          </>}
        </>}
      </>}
    </form>
  </Dialog>;
}
