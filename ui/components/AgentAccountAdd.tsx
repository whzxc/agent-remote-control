import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { accountsApi } from '../api';
import { t } from '../i18n';
import { refreshAccounts } from '../state/accounts';
import type { AccountLogin, CodexAccountImport } from '../types';
import { Button, Dialog, Field, Input, Notice, SingleChoice, Textarea } from './ui';
import './AgentAccountAdd.css';

type Method = 'oauth' | 'import';
type Owner = CodexAccountImport['refreshOwner'];
type Errors = Partial<Record<'auth' | 'program' | 'args', string>>;

export default function AgentAccountAdd({ onClose }: { onClose: () => void }) {
  const id = useId();
  const [method, setMethod] = useState<Method>('oauth'), [owner, setOwner] = useState<Owner>('codex');
  const [auth, setAuth] = useState(''), [program, setProgram] = useState(''), [args, setArgs] = useState('');
  const [browsers, setBrowsers] = useState<Array<{ id: string; name: string }>>([]), [browser, setBrowser] = useState('default');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [errors, setErrors] = useState<Errors>({});
  const [login, setLogin] = useState<AccountLogin | null>(null);
  const closing = useRef(false);
  useEffect(() => { void accountsApi.browsers().then(v => setBrowsers(v.browsers)).catch(e => setError(String(e))); }, []);
  useEffect(() => {
    if (login?.state !== 'waiting') return;
    let stopped = false, timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await accountsApi.list();
        if (stopped) return;
        if (result.login?.loginId === login.loginId) {
          if (result.login.state === 'completed') { await refreshAccounts(); if (!stopped) onClose(); return; }
          setLogin(result.login);
          if (result.login.state === 'failed') { setError(result.login.error ?? t('accountAdd.loginFailed')); return; }
          if (result.login.state === 'cancelled') return;
        }
      } catch (e) { if (!stopped) setError(String(e)); }
      if (!stopped) timer = setTimeout(poll, 1000);
    };
    timer = setTimeout(poll, 300);
    return () => { stopped = true; clearTimeout(timer); };
  }, [login?.loginId, login?.state, onClose]);
  async function close() {
    if (closing.current) return;
    closing.current = true;
    if (login?.state === 'waiting') {
      try { await accountsApi.login({ loginId: login.loginId, action: 'cancel' }); }
      catch (e) { closing.current = false; setError(String(e)); return; }
    }
    onClose();
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
      if (method === 'oauth') {
        const result = await accountsApi.add({ kind: 'codex', browserId: browser });
        setLogin(result); if (result.browserError) setError(result.browserError);
      } else {
        await accountsApi.importCodex({ auth: credentials, refreshOwner: owner, ...(owner === 'external' ? { refreshCommand: { program: program.trim(), args: arguments_ } } : {}) });
        setAuth(''); await refreshAccounts(); onClose();
      }
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  }
  const waiting = login?.state === 'waiting';
  return <Dialog title={t('accountAdd.title')} width={560} className="agent-account-add" busy={busy} onClose={close} returnFocus="[data-add-codex-account]" footer={<div className="actions">
    <Button disabled={busy} onClick={() => void close()}>{t('cancel')}</Button>
    {!waiting && <Button form={`${id}-form`} type="submit" variant="primary" busy={busy}>{t(method === 'oauth' ? 'accountAdd.login' : 'accountAdd.import')}</Button>}
  </div>}>
    <form id={`${id}-form`} className="agent-account-add-form" onSubmit={event => void submit(event)}>
      {error && <Notice tone="danger">{error}</Notice>}
      {waiting ? <p role="status">{t('accounts.login.waiting')}</p> : <>
        <SingleChoice label={t('accountAdd.method')} value={method} onChange={v => setMethod(v as Method)} fill disabled={busy} options={[
          { value: 'oauth', label: t('accountAdd.oauth') }, { value: 'import', label: t('accountAdd.credentials') },
        ]} />
        {method === 'oauth' ? <Field label={t('accountAdd.browser')}><SingleChoice label={t('accountAdd.browser')} value={browser} onChange={setBrowser} disabled={busy} dropdown fill options={[
          { value: 'default', label: t('accountAdd.defaultBrowser') }, ...browsers.map(b => ({ value: b.id, label: b.name })),
        ]} /></Field> : <>
          <Field id={`${id}-auth`} label={t('accountAdd.auth')} error={errors.auth}><Textarea id={`${id}-auth`} value={auth} onChange={e => setAuth(e.target.value)} disabled={busy} spellCheck={false} autoComplete="off" rows={5} placeholder={t('accountAdd.authPlaceholder')} aria-invalid={!!errors.auth} aria-describedby={errors.auth ? `${id}-auth-error` : undefined} /></Field>
          <Field label={t('accountAdd.refresh')}><SingleChoice label={t('accountAdd.refresh')} value={owner} onChange={v => setOwner(v as Owner)} disabled={busy} fill options={[
            { value: 'codex', label: t('accountAdd.codexRefresh') }, { value: 'none', label: t('accountAdd.noRefresh') }, { value: 'external', label: t('accountAdd.external') },
          ]} /></Field>
          {owner === 'external' && <>
            <Field id={`${id}-program`} label={t('accountAdd.program')} error={errors.program}><Input id={`${id}-program`} value={program} disabled={busy} onChange={e => setProgram(e.target.value)} placeholder={t('accountAdd.programPlaceholder')} aria-invalid={!!errors.program} aria-describedby={errors.program ? `${id}-program-error` : undefined} /></Field>
            <Field id={`${id}-args`} label={t('accountAdd.args')} error={errors.args}><Input id={`${id}-args`} value={args} disabled={busy} onChange={e => setArgs(e.target.value)} placeholder={'["--account", "account-id"]'} aria-invalid={!!errors.args} aria-describedby={errors.args ? `${id}-args-error` : undefined} /></Field>
          </>}
        </>}
      </>}
    </form>
  </Dialog>;
}
