import { useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { openUrl } from '../platform';
import { Button, Checkbox, Dialog, Empty, Field, Icon, IconButton, Input, Loading, Notice, SingleChoice, Status } from '../components/ui';
import { Sensitive } from '../components/Sensitive';
import type { McpService, McpSnapshot, McpSupport, McpTool, NativeMcp } from './state';
import './mcp.css';

function Tools({ tools }: { tools: McpTool[] }) {
  return <details className="mcp-tools"><summary>{t('mcp.tools', { count: tools.length })}</summary>
    {tools.length ? tools.map(tool => <details key={tool.name} className="mcp-tool"><summary><code>{tool.name}</code></summary>
      {tool.description && <p>{tool.description}</p>}
      {tool.inputSchema !== undefined && <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>}
    </details>) : <p className="muted">{t('mcp.noTools')}</p>}
  </details>;
}

function ServiceEditor({ service, support, onClose, onSaved }: {
  service?: McpService; support: McpSupport[]; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(service?.name ?? ''), [transport, setTransport] = useState(service?.transport ?? 'stdio');
  const [command, setCommand] = useState(service?.command ?? ''), [url, setUrl] = useState('');
  const [args, setArgs] = useState(''), [env, setEnv] = useState(''), [headers, setHeaders] = useState('');
  const [selected, setSelected] = useState(service?.agents ?? []), [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({}), [error, setError] = useState('');
  const form = useRef<HTMLFormElement>(null);
  const changedTransport = !!service && service.transport !== transport;
  const existing = !!service && !changedTransport;
  const saved = (configured: boolean) => existing && configured ? t('savedLeaveBlankToKeep') : undefined;
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError('');
    const invalid: Record<string, string> = {}, configuration: Record<string, unknown> = { name, transport, agents: selected };
    if (!name.trim() || Array.from(name).length > 128 || name === 'context-provider') invalid.name = t('mcp.invalidName');
    if (transport === 'stdio') {
      configuration.command = command;
      if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(command)) invalid.command = t('mcp.absoluteCommand');
    } else if (url.trim() || !existing) {
      configuration.url = url;
      try { const parsed = new URL(url); if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw new Error(); }
      catch { invalid.url = t('mcp.invalidUrl'); }
    }
    for (const [field, raw] of transport === 'stdio' ? [['args', args], ['env', env]] : [['headers', headers]]) {
      if (!raw.trim() && existing) continue;
      try {
        const value: unknown = JSON.parse(raw.trim() || (field === 'args' ? '[]' : '{}'));
        if (field === 'args' ? !Array.isArray(value) || value.some(item => typeof item !== 'string') : !value || Array.isArray(value) || typeof value !== 'object' || Object.values(value).some(item => typeof item !== 'string')) throw new Error();
        configuration[field] = value;
      } catch { invalid[field] = t(field === 'args' ? 'mcp.invalidArgs' : 'mcp.invalidMap'); }
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) { requestAnimationFrame(() => document.getElementById(`mcp-${Object.keys(invalid)[0]}`)?.focus()); return; }
    setBusy(true);
    try {
      await api('mcp-services/save', 'POST', { ...(service ? { id: service.id, expectedRevision: service.revision } : {}), configuration });
      await onSaved(); onClose();
    } catch (error) {
      const message = String(error);
      const field = [['MCP_INVALID_NAME', 'name'], ['MCP_NAME_EXISTS', 'name'], ['MCP_INVALID_COMMAND', 'command'], ['MCP_INVALID_URL', 'url'], ['MCP_INVALID_HEADER', 'headers'], ['MCP_INVALID_ENV', 'env']].find(([code]) => message.includes(code))?.[1];
      if (field) { setErrors({ [field]: message }); requestAnimationFrame(() => document.getElementById(`mcp-${field}`)?.focus()); }
      else setError(message);
    }
    finally { setBusy(false); }
  }
  const input = (id: string, label: string, value: string, update: (v: string) => void, options: { placeholder?: string; secret?: boolean; required?: boolean } = {}) =>
    <Field id={`mcp-${id}`} label={label} error={errors[id]}><Input id={`mcp-${id}`} value={value} onChange={e => update(e.target.value)}
      type={options.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} disabled={busy} required={options.required}
      placeholder={options.placeholder} aria-invalid={!!errors[id]} aria-describedby={errors[id] ? `mcp-${id}-error` : undefined} /></Field>;
  return <Dialog title={t(service ? 'mcp.edit' : 'mcp.add')} onClose={onClose} busy={busy} width={560} footer={<>
    <Button disabled={busy} onClick={onClose}>{t('cancel')}</Button><Button variant="primary" busy={busy} onClick={() => form.current?.requestSubmit()}>{t('save')}</Button>
  </>}>
    <form ref={form} onSubmit={save} noValidate className="mcp-form">
      {input('name', t('mcp.name'), name, setName, { required: true })}
      <Field label={t('mcp.transport')}><SingleChoice label={t('mcp.transport')} value={transport} disabled={busy} onChange={value => setTransport(value as 'stdio' | 'http')}
        options={[{ value: 'stdio', label: 'stdio' }, { value: 'http', label: 'Streamable HTTP' }]} /></Field>
      {transport === 'stdio' ? <>
        {input('command', t('mcp.command'), command, setCommand, { required: true, placeholder: t('mcp.absoluteCommand') })}
        {input('args', t('mcp.args'), args, setArgs, { secret: true, placeholder: saved(!!service?.argsConfigured) ?? '["--stdio"]' })}
        {input('env', t('mcp.env'), env, setEnv, { secret: true, placeholder: saved(!!service?.envNames.length) ?? '{"API_KEY":"…"}' })}
      </> : <>
        {input('url', t('mcp.endpoint'), url, setUrl, { secret: true, required: !existing, placeholder: saved(true) ?? 'https://tools.example/mcp' })}
        {input('headers', t('mcp.headers'), headers, setHeaders, { secret: true, placeholder: saved(!!service?.headerNames.length) ?? '{"Authorization":"Bearer …"}' })}
      </>}
      <p className="muted small">{t('mcp.secretFields')}</p>
      <Field label={t('mcp.agents')}><div className="mcp-agent-options">{support.map(agent => <div key={agent.agent}>
        <Checkbox disabled={busy || !agent.configurable} checked={selected.includes(agent.agent)} onChange={checked => setSelected(old => checked ? [...old, agent.agent] : old.filter(id => id !== agent.agent))}>
          {agent.displayName || agent.agent}
        </Checkbox><span className="muted small">{t(agent.configurable ? 'mcp.acpSupport' : agent.agent === 'codex' ? 'mcp.codexSupport' : 'mcp.nativeSupport')}</span>
      </div>)}</div></Field>
      {error && <Notice>{error}</Notice>}
    </form>
  </Dialog>;
}

export default function McpServices() {
  locale.use();
  const [snapshot, setSnapshot] = useState<McpSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [editor, setEditor] = useState<McpService | 'new'>(), [removing, setRemoving] = useState<McpService>();
  const [native, setNative] = useState<{ services: NativeMcp[]; checkedAt: string }>(), [nativeError, setNativeError] = useState('');
  async function refresh() { setSnapshot(await api<McpSnapshot>('mcp-services')); }
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, []);
  async function action(key: string, op: string, body: unknown) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setBusy(key); setError('');
    try { await api(`mcp-services/${op}`, 'POST', body); await refresh(); setRemoving(undefined); }
    catch (error) { setError(String(error)); }
    finally { setBusy(''); requestAnimationFrame(() => { if (document.activeElement === document.body) (trigger?.isConnected ? trigger : document.getElementById('mcp-add-service'))?.focus({ preventScroll: true }); }); }
  }
  async function nativeAction(name?: string) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setBusy(name ? `login-${name}` : 'native'); setNativeError('');
    try {
      if (name) {
        const result = await api<Record<string, unknown>>('mcp-services/native-login', 'POST', { name });
        let value = result;
        for (let i = 0; i < 5 && !value.authorizationUrl; i++) {
          if (!value.result || typeof value.result !== 'object') break;
          value = value.result as Record<string, unknown>;
        }
        if (typeof value.authorizationUrl === 'string') await openUrl(value.authorizationUrl);
        else { setNativeError(t('mcp.nativeLoginPending')); return; }
      } else { setNative(await api('mcp-services/native', 'POST', {})); }
    } catch (error) { setNativeError(String(error)); }
    finally { setBusy(''); requestAnimationFrame(() => { if (document.activeElement === document.body && trigger?.isConnected) trigger.focus({ preventScroll: true }); }); }
  }
  if (!snapshot) return error ? <Notice action={<Button onClick={() => { setError(''); void refresh().catch(error => setError(String(error))); }}>{t('retry')}</Button>}>{error}</Notice> : <Loading />;
  const names = (ids: string[]) => ids.map(id => snapshot.support.find(a => a.agent === id)?.displayName || id).join(', ');
  return <div className="mcp-page">
    <div className="mcp-toolbar"><Button id="mcp-add-service" variant="primary" onClick={() => setEditor('new')}><Icon icon={Plus} />{t('mcp.add')}</Button>
      <IconButton icon={RefreshCw} label={t('refresh')} disabled={!!busy} onClick={() => { void refresh().catch(error => setError(String(error))); }} /></div>
    <p className="muted">{t('mcp.applies')}</p>
    {error && <Notice>{error}</Notice>}
    {!snapshot.services.length && <Empty>{t('mcp.empty')}</Empty>}
    <div className="mcp-service-list">{snapshot.services.map(service => <article className="mcp-card" key={service.id} aria-label={service.name}>
      <div className="mcp-card-heading"><h2><Sensitive>{service.name}</Sensitive></h2><Status tone={service.check.state === 'ready' ? 'success' : service.check.state === 'failed' ? 'danger' : 'neutral'}>{t(service.check.state === 'ready' ? 'mcp.ready' : service.check.state === 'failed' ? 'mcp.failed' : 'mcp.unchecked')}</Status></div>
      <div className="mcp-connection"><code>{service.transport === 'http' ? 'Streamable HTTP → ARC → stdio' : 'stdio'}</code><Sensitive>{service.transport === 'http' ? service.endpoint : service.command}</Sensitive></div>
      <p>{t('mcp.agents')}: {service.agents.length ? names(service.agents) : t('mcp.noAgents')}</p>
      {service.source && <p className="muted small">{t('mcp.adopted', { agent: service.source.agent })}</p>}
      {service.sourceChanged && <Notice>{t('mcp.sourceChanged')}</Notice>}
      {service.check.checkedAt && <time className="muted small" dateTime={service.check.checkedAt}>{t('mcp.checkedAt', { time: new Date(service.check.checkedAt).toLocaleString() })}</time>}
      {service.check.state === 'failed' && <Notice>{`${service.check.stage}: ${service.check.error}`}</Notice>}
      <div className="actions"><Button busy={busy === service.id} disabled={!!busy} onClick={() => void action(service.id, 'check', { id: service.id })}>{t('mcp.check')}</Button>
        <Button disabled={!!busy} onClick={() => setEditor(service)}>{t('mcp.edit')}</Button>
        <Button variant="ghost" disabled={!!busy} onClick={() => setRemoving(service)}>{t('delete')}</Button></div>
      {service.check.state === 'ready' && <Tools tools={service.check.tools} />}
    </article>)}</div>
    {!!snapshot.legacy.length && <section className="mcp-section"><h2>{t('mcp.existingAcp')}</h2>{snapshot.legacy.map(source => <div key={`${source.agent}/${source.name}`} className="mcp-legacy-row">
      <div><strong><Sensitive>{source.name}</Sensitive></strong><p className="muted small">{names([source.agent])}</p></div>
      {source.adoptedBy ? <span className="muted">{t('mcp.managed')}</span> : <Button disabled={!!busy} onClick={() => void action(`adopt-${source.agent}-${source.name}`, 'adopt', { agent: source.agent, name: source.name })}>{t('mcp.adopt')}</Button>}
    </div>)}</section>}
    <section className="mcp-section"><div className="mcp-card-heading"><h2>{t('mcp.nativeCodex')}</h2><Button disabled={!!busy} busy={busy === 'native'} onClick={() => void nativeAction()}>{t('mcp.nativeCheck')}</Button></div>
      {nativeError && <Notice>{nativeError}</Notice>}
      {native && !native.services.length && <p className="muted">{t('mcp.nativeEmpty')}</p>}
      {native?.services.map(service => <article className="mcp-card" key={service.name} aria-label={`Codex ${service.name}`}>
        <div className="mcp-card-heading"><h3><Sensitive>{service.name}</Sensitive></h3><Status>{service.runtimeStatus || t('mcp.nativeUnobserved')}</Status></div>
        <p>{t('mcp.authentication')}: {service.authStatus}</p>
        {['notLoggedIn', 'oAuth'].includes(service.authStatus) && <Button disabled={!!busy} busy={busy === `login-${service.name}`} onClick={() => void nativeAction(service.name)}>{t('mcp.nativeLogin')}</Button>}
        <Tools tools={Array.isArray(service.tools) ? service.tools : Object.values(service.tools || {})} />
      </article>)}
    </section>
    <details className="mcp-section"><summary>{t('mcp.support')}</summary><div className="mcp-support">{snapshot.support.map(agent => <div key={agent.agent}><strong>{agent.displayName || agent.agent}</strong><span>{t(agent.configurable ? 'mcp.acpSupport' : agent.agent === 'codex' ? 'mcp.codexSupport' : 'mcp.nativeSupport')}</span></div>)}</div></details>
    {editor && <ServiceEditor key={typeof editor === 'string' ? 'new' : `${editor.id}-${editor.revision}`} service={editor === 'new' ? undefined : editor} support={snapshot.support} onClose={() => setEditor(undefined)} onSaved={refresh} />}
    {removing && <Dialog title={t('mcp.remove')} onClose={() => setRemoving(undefined)} busy={!!busy} footer={<><Button disabled={!!busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button><Button variant="danger" busy={!!busy} onClick={() => void action(removing.id, 'remove', { id: removing.id, expectedRevision: removing.revision })}>{t('delete')}</Button></>}>
      <p>{t('mcp.removeEffect', { name: removing.name })}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
  </div>;
}
