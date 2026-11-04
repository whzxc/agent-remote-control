import { useEffect, useId, useState } from 'react';
import { Check, ChevronDown, Copy, Globe, Plug, Plus, RefreshCw, Search, SquareTerminal, Trash2 } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { copyText } from '../platform';
import { useAppNow } from '../state/appEnvironment';
import { relativeTime } from '../lib/relativeTime';
import { Button, Dialog, Icon, IconButton, Input, Loading, Notice, SingleChoice, Status, Switch } from '../components/ui';
import { Sensitive } from '../components/Sensitive';
import { failureKind, hubSummary, matchServer } from './model';
import type { HubServer, HubSnapshot, HubTool } from './state';
import './mcp.css';

const tone = (state: HubServer['state']) => state === 'ready' || state === 'idle' ? 'success' : state === 'failed' ? 'danger' : state === 'connecting' ? 'warning' : 'neutral';
const profiles = ['codex', 'claude', 'cursor', 'gemini'] as const;
const profileName = (from?: string) => from && (profiles as readonly string[]).includes(from) ? t(`mcp.profile.${from}`) : from ?? '';

function useCopy() {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = (text: string) => { setError(''); void copyText(text).then(() => setCopied(true), () => setError(t('copyFailedSelectAndCopyTheTextManually'))); };
  return { copied, error, copy };
}

/** A prompt the user pastes into a connected Agent. Prompts carry no secrets, so they stay readable in privacy mode. */
function PromptCopy({ label, text }: { label: string; text: string }) {
  const { copied, error, copy } = useCopy(), id = useId();
  return <div className="mcp-prompt">
    <p id={id} className="mcp-prompt-text">{text}</p>
    <Button aria-describedby={id} onClick={() => copy(text)}><Icon icon={copied ? Check : Copy} />{t(copied ? 'copied' : 'mcp.copyPrompt')}<span className="sr-only">{label}</span></Button>
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}

function ImportPrompt() {
  const [from, setFrom] = useState<string>('codex');
  return <div className="mcp-import">
    <SingleChoice compact label={t('mcp.importFrom')} value={from} onChange={setFrom} options={profiles.map(value => ({ value, label: t(`mcp.profile.${value}`) }))} />
    <PromptCopy label={t('mcp.importFrom')} text={t('mcp.promptImport', { from: t(`mcp.profile.${from}`) })} />
  </div>;
}

function ToolRow({ tool }: { tool: HubTool }) {
  return <li className="mcp-tool">
    <div className="mcp-tool-name"><code>{tool.name}</code>
      {tool.readOnly && <span className="mcp-hint">{t('mcp.readOnly')}</span>}
      {tool.destructive && !tool.readOnly && <span className="mcp-hint danger">{t('mcp.destructive')}</span>}
    </div>
    {tool.description && <p>{tool.description}</p>}
  </li>;
}

function Failure({ server }: { server: HubServer }) {
  const { copied, error, copy } = useCopy(), kind = failureKind(server.error);
  return <div className="mcp-failure">
    <div className="mcp-failure-copy">
      <strong>{t(`mcp.failure.${kind}`)}</strong>
      <p>{t(`mcp.failureHint.${kind}`)}</p>
      <code className="mcp-failure-detail">{server.error}</code>
    </div>
    <Button onClick={() => copy(t('mcp.promptFix', { name: server.name, error: server.error ?? '' }))}><Icon icon={copied ? Check : Copy} />{t(copied ? 'copied' : 'mcp.copyFix')}</Button>
    {error && <p className="field-error" role="alert">{error}</p>}
  </div>;
}

function Server({ server, query, busy, act, remove, now }: { server: HubServer; query: string; busy: string; act: (action: string, server: HubServer) => void; remove: (server: HubServer) => void; now: number }) {
  const [open, setOpen] = useState(false), headingId = useId(), toolsId = useId();
  const match = matchServer(server, query), searching = !!query.trim();
  const expanded = open || searching && match.tools.length > 0 && match.tools.length < (server.tools?.length ?? 0);
  const origin = server.addedBy?.kind === 'import' ? t('mcp.importedFrom', { from: profileName(server.addedBy.from) })
    : server.addedBy?.sourceLabel ? t('mcp.addedBy', { source: server.addedBy.sourceLabel })
    : server.addedBy?.kind === 'local' ? t('mcp.addedLocally') : '';
  const checked = server.enabled && server.observedAt ? relativeTime(server.observedAt, now, locale.get(), t('time.justNow')) : '';
  const target = server.transport === 'http' ? server.endpoint : server.command;
  const shown = searching ? match.tools : server.tools ?? [];
  return <article className="mcp-server" data-state={server.state} aria-labelledby={headingId}>
    <div className="mcp-server-head">
      <span className="mcp-server-icon"><Icon icon={server.transport === 'http' ? Globe : SquareTerminal} /></span>
      <div className="mcp-server-identity">
        <h3 id={headingId}>{server.name}</h3>
        <p><span>{t(server.transport === 'http' ? 'mcp.transport.http' : 'mcp.transport.stdio')}</span>{target && <><span aria-hidden="true">·</span><span className="mcp-target"><Sensitive>{target}</Sensitive></span></>}</p>
      </div>
      <span className="mcp-server-state" data-tone={tone(server.state)}><Status tone={tone(server.state)}>{t(`mcp.state.${server.state}`)}</Status></span>
      <div className="mcp-server-actions">
        <IconButton icon={RefreshCw} label={t('mcp.check', { name: server.name })} busy={busy === `refresh:${server.name}`} disabled={!!busy || !server.enabled} onClick={() => act('refresh', server)} />
        <IconButton icon={Trash2} label={t('mcp.remove', { name: server.name })} disabled={!!busy} onClick={() => remove(server)} />
        <Switch label={t('mcp.enable', { name: server.name })} checked={server.enabled} disabled={!!busy} onChange={enabled => act(enabled ? 'enable' : 'disable', server)} />
      </div>
    </div>
    {server.enabled && server.state === 'failed' && server.error && <Failure server={server} />}
    <div className="mcp-server-meta">
      {server.toolCount !== undefined && (server.toolCount > 0
        ? <Button variant="ghost" className="mcp-tools-toggle" aria-expanded={expanded} aria-controls={toolsId} onClick={() => setOpen(!expanded)}>
          {searching && match.tools.length < server.toolCount ? t('mcp.toolsMatched', { count: match.tools.length, total: server.toolCount }) : t('mcp.tools', { count: server.toolCount })}
          <Icon icon={ChevronDown} className={expanded ? 'mcp-chevron open' : 'mcp-chevron'} />
        </Button>
        : <span className="mcp-fact">{t('mcp.noTools')}</span>)}
      {!!server.envNames.length && <span className="mcp-fact">{t('mcp.envNames', { names: server.envNames.join(', ') })}</span>}
      {!!server.headerNames.length && <span className="mcp-fact">{t('mcp.headerNames', { names: server.headerNames.join(', ') })}</span>}
      {origin && <span className="mcp-fact">{origin}</span>}
      {checked && <time className="mcp-fact" dateTime={server.observedAt!}>{t('mcp.checked', { time: checked })}</time>}
    </div>
    {expanded && !!shown.length && <ul id={toolsId} className="mcp-tools" aria-label={t('mcp.toolList')}>{shown.map(tool => <ToolRow key={tool.name} tool={tool} />)}</ul>}
  </article>;
}

export default function McpHub() {
  locale.use();
  const now = useAppNow(30_000);
  const [snapshot, setSnapshot] = useState<HubSnapshot>(), [error, setError] = useState(''), [busy, setBusy] = useState('');
  const [removing, setRemoving] = useState<HubServer>(), [adding, setAdding] = useState(false), [query, setQuery] = useState(''), [reading, setReading] = useState(false);
  const refresh = () => { setReading(true); return api<HubSnapshot>('mcp-hub').then(value => { setSnapshot(value); setError(''); }, error => setError(String(error))).finally(() => setReading(false)); };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
    return () => clearInterval(timer);
  }, []);
  async function act(action: string, server: HubServer) {
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    setBusy(`${action}:${server.name}`); setError('');
    try {
      const result = await api<{ error?: { message?: string } }>('mcp-hub/configure', 'POST', { action, name: server.name });
      if (result?.error?.message) setError(result.error.message);
      await refresh(); setRemoving(undefined);
    } catch (error) { setError(String(error)); }
    finally { setBusy(''); requestAnimationFrame(() => { if (document.activeElement === document.body && trigger?.isConnected) trigger.focus({ preventScroll: true }); }); }
  }
  if (!snapshot) return error ? <Notice action={<Button onClick={() => { setError(''); void refresh(); }}>{t('retry')}</Button>}>{error}</Notice> : <Loading />;
  const summary = hubSummary(snapshot.servers);
  const visible = snapshot.servers.filter(server => matchServer(server, query).server);
  return <div className="mcp-page">
    {error && <Notice>{error}</Notice>}
    {snapshot.servers.length ? <>
      <header className="mcp-summary">
        <p className="mcp-stats">
          <span>{t('mcp.serverCount', { count: summary.total })}</span>
          <span>{t('mcp.availableCount', { count: summary.available })}</span>
          {summary.failed > 0 && <span className="danger">{t('mcp.failedCount', { count: summary.failed })}</span>}
          <span>{t('mcp.toolTotal', { count: summary.tools })}</span>
        </p>
        <div className="mcp-summary-actions">
          <label className="mcp-search"><Icon icon={Search} /><span className="sr-only">{t('mcp.search')}</span>
            <Input type="search" value={query} placeholder={t('mcp.search')} onChange={event => setQuery(event.target.value)} />
          </label>
          <IconButton icon={RefreshCw} label={t('refresh')} busy={reading && !busy} disabled={!!busy} onClick={() => void refresh()} />
          <Button onClick={() => setAdding(true)}><Icon icon={Plus} />{t('mcp.add')}</Button>
        </div>
      </header>
      <div className="mcp-servers">{visible.map(server => <Server key={server.name} server={server} query={query} busy={busy} act={act} remove={setRemoving} now={now} />)}</div>
      {!visible.length && <p className="mcp-no-match" role="status">{t('mcp.noMatch')}</p>}
    </> : <section className="mcp-empty" aria-labelledby="mcp-empty-title">
      <span className="mcp-empty-icon"><Icon icon={Plug} size={20} /></span>
      <h3 id="mcp-empty-title">{t('mcp.emptyTitle')}</h3>
      <p>{t('mcp.empty')}</p>
      <ImportPrompt />
    </section>}
    {adding && <Dialog title={t('mcp.addTitle')} width={520} onClose={() => setAdding(false)} footer={<Button onClick={() => setAdding(false)}>{t('close')}</Button>}>
      <div className="mcp-add">
        <p>{t('mcp.addIntro')}</p>
        <section aria-label={t('mcp.addImport')}><h3>{t('mcp.addImport')}</h3><ImportPrompt /></section>
        <section aria-label={t('mcp.addHttp')}><h3>{t('mcp.addHttp')}</h3><PromptCopy label={t('mcp.addHttp')} text={t('mcp.promptHttp')} /></section>
        <section aria-label={t('mcp.addStdio')}><h3>{t('mcp.addStdio')}</h3><PromptCopy label={t('mcp.addStdio')} text={t('mcp.promptStdio')} /></section>
      </div>
    </Dialog>}
    {removing && <Dialog title={t('mcp.remove', { name: removing.name })} onClose={() => setRemoving(undefined)} busy={!!busy} footer={<>
      <Button disabled={!!busy} onClick={() => setRemoving(undefined)}>{t('cancel')}</Button>
      <Button variant="danger" busy={!!busy} onClick={() => void act('remove', removing)}>{t('delete')}</Button>
    </>}>
      <p>{t('mcp.removeEffect', { name: removing.name })}</p>
    </Dialog>}
  </div>;
}
