import { useEffect, useId, useState } from 'react';
import { Check, Copy, Globe, Plug, Plus, RotateCw, Terminal, Trash } from 'lucide-react';
import { api } from '../api';
import { locale, t } from '../i18n';
import { copyText } from '../platform';
import { useAppNow } from '../state/appEnvironment';
import { relativeTime } from '../lib/relativeTime';
import { Button, Dialog, Disclosure, Icon, IconButton, Loading, Notice, Prompt, SearchInput, SingleChoice, Status, Switch, Tag, Tile } from '../components/ui';
import { failureKind, hubSummary, matchServer } from './model';
import type { HubServer, HubSnapshot, HubTool } from './state';
import './mcp.css';

const tone = (state: HubServer['state']) => state === 'ready' || state === 'idle' ? 'success' : state === 'failed' ? 'danger' : state === 'connecting' ? 'warning' : 'neutral';
const profiles = ['codex', 'claude', 'cursor', 'gemini'] as const;
const profileName = (from?: string) => from && (profiles as readonly string[]).includes(from) ? t(`mcp.profile.${from}`) : from ?? '';

/** Shows a counted label with its number emphasized, wherever the locale places the number. */
function Count({ id, count, danger = false }: { id: string; count: number; danger?: boolean }) {
  const text = t(id, { count }), number = String(count), at = text.indexOf(number);
  const before = at < 0 ? text : text.slice(0, at).trim(), after = at < 0 ? '' : text.slice(at + number.length).trim();
  return <span className={danger ? 'mcp-stat danger' : 'mcp-stat'}>{before && <span>{before}</span>}{at >= 0 && <strong>{number}</strong>}{after && <span>{after}</span>}</span>;
}

function ImportPrompt() {
  const [from, setFrom] = useState<string>('codex');
  return <div className="mcp-import">
    <SingleChoice compact label={t('mcp.importFrom')} value={from} onChange={setFrom} options={profiles.map(value => ({ value, label: t(`mcp.profile.${value}`) }))} />
    <Prompt label={t('mcp.copyPrompt')} context={t('mcp.importFrom')} text={t('mcp.promptImport', { from: t(`mcp.profile.${from}`) })} />
  </div>;
}

function ToolRow({ tool }: { tool: HubTool }) {
  return <li className="mcp-tool">
    <div className="mcp-tool-name"><code>{tool.name}</code>
      {tool.readOnly && <Tag>{t('mcp.readOnly')}</Tag>}
      {tool.destructive && !tool.readOnly && <Tag form="danger">{t('mcp.destructive')}</Tag>}
    </div>
    {tool.description && <p>{tool.description}</p>}
  </li>;
}

function Failure({ server }: { server: HubServer }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState(''), kind = failureKind(server.error);
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); }, [copied]);
  const copy = () => { setError(''); void copyText(t('mcp.promptFix', { name: server.name, error: server.error ?? '' })).then(() => setCopied(true), () => setError(t('copyFailedSelectAndCopyTheTextManually'))); };
  return <Notice title={t(`mcp.failure.${kind}`)} action={<Button onClick={copy}><Icon icon={copied ? Check : Copy} />{t(copied ? 'copied' : 'mcp.copyFix')}</Button>}>
    <p>{t(`mcp.failureHint.${kind}`)}</p>
    <code>{server.error}</code>
    {error && <p className="field-error" role="alert">{error}</p>}
  </Notice>;
}

function Server({ server, query, busy, act, remove, now }: { server: HubServer; query: string; busy: string; act: (action: string, server: HubServer) => void; remove: (server: HubServer) => void; now: number }) {
  const [open, setOpen] = useState(false), headingId = useId(), toolsId = useId();
  const match = matchServer(server, query), searching = !!query.trim();
  const expanded = open || searching && match.tools.length > 0 && match.tools.length < (server.tools?.length ?? 0);
  const origin = server.addedBy?.kind === 'import' ? t('mcp.importedFrom', { from: profileName(server.addedBy.from) })
    : server.addedBy?.sourceLabel ? t('mcp.addedBy', { source: server.addedBy.sourceLabel })
    : server.addedBy?.kind === 'local' ? t('mcp.addedLocally') : '';
  const checked = server.enabled && server.observedAt ? relativeTime(server.observedAt, now, locale.get(), t('time.justNow')) : '';
  const http = server.transport === 'http', target = http ? server.endpoint : server.command;
  const transport = t(http ? 'mcp.transport.http' : 'mcp.transport.stdio');
  const shown = searching ? match.tools : server.tools ?? [];
  const failure = server.enabled && server.state === 'failed' && !!server.error;
  const facts = [
    !!server.envNames.length && t('mcp.envNames', { names: server.envNames.join(', ') }),
    !!server.headerNames.length && t('mcp.headerNames', { names: server.headerNames.join(', ') }),
    origin,
  ].filter((fact): fact is string => !!fact);
  const meta = server.toolCount !== undefined || facts.length > 0 || !!checked;
  return <article className="mcp-server" data-state={server.state} data-transport={server.transport} aria-labelledby={headingId}>
    <div className="mcp-server-head">
      <Tile icon={http ? Globe : Terminal} />
      <div className="mcp-server-identity">
        <h3 id={headingId}>{server.name}</h3>
        <p>{target ? `${transport} · ` : transport}{target && <span className="mcp-target" title={target}>{target}</span>}</p>
      </div>
      <Status tone={tone(server.state)}>{t(`mcp.state.${server.state}`)}</Status>
      <div className="mcp-server-actions">
        <IconButton compact icon={RotateCw} label={t('mcp.check', { name: server.name })} busy={busy === `refresh:${server.name}`} disabled={!!busy || !server.enabled} onClick={() => act('refresh', server)} />
        <IconButton compact icon={Trash} label={t('mcp.remove', { name: server.name })} disabled={!!busy} onClick={() => remove(server)} />
        <Switch label={t('mcp.enable', { name: server.name })} checked={server.enabled} disabled={!!busy} onChange={enabled => act(enabled ? 'enable' : 'disable', server)} />
      </div>
    </div>
    {(failure || meta || expanded) && <div className="mcp-server-body">
      {failure && <Failure server={server} />}
      {meta && <div className="mcp-server-meta">
        {server.toolCount !== undefined && (server.toolCount > 0
          ? <Disclosure expanded={expanded} controls={toolsId} onToggle={() => setOpen(!expanded)}>
            {searching && match.tools.length < server.toolCount ? t('mcp.toolsMatched', { count: match.tools.length, total: server.toolCount }) : t('mcp.tools', { count: server.toolCount })}
          </Disclosure>
          : <Tag form="fact">{t('mcp.noTools')}</Tag>)}
        {facts.map(fact => <Tag key={fact} form="fact">{fact}</Tag>)}
        {checked && <time className="tag" data-form="fact" dateTime={server.observedAt!}>{t('mcp.checked', { time: checked })}</time>}
      </div>}
      {expanded && !!shown.length && <ul id={toolsId} className="mcp-tools" aria-label={t('mcp.toolList')}>{shown.map(tool => <ToolRow key={tool.name} tool={tool} />)}</ul>}
    </div>}
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
          <Count id="mcp.serverCount" count={summary.total} />
          <Count id="mcp.availableCount" count={summary.available} />
          {summary.failed > 0 && <Count id="mcp.failedCount" count={summary.failed} danger />}
          <Count id="mcp.toolTotal" count={summary.tools} />
        </p>
        <div className="mcp-summary-actions">
          <SearchInput className="mcp-search" value={query} placeholder={t('mcp.search')} onChange={event => setQuery(event.target.value)} />
          <IconButton icon={RotateCw} label={t('refresh')} busy={reading && !busy} disabled={!!busy} onClick={() => void refresh()} />
          <Button variant="primary" onClick={() => setAdding(true)}><Icon icon={Plus} />{t('mcp.add')}</Button>
        </div>
      </header>
      <div className="mcp-servers">{visible.map(server => <Server key={server.name} server={server} query={query} busy={busy} act={act} remove={setRemoving} now={now} />)}</div>
      {!visible.length && <p className="mcp-no-match" role="status">{t('mcp.noMatch')}</p>}
    </> : <section className="mcp-empty" aria-labelledby="mcp-empty-title">
      <Tile icon={Plug} />
      <h3 id="mcp-empty-title">{t('mcp.emptyTitle')}</h3>
      <p>{t('mcp.empty')}</p>
      <ImportPrompt />
    </section>}
    {adding && <Dialog title={t('mcp.addTitle')} width={520} onClose={() => setAdding(false)} footer={<Button onClick={() => setAdding(false)}>{t('close')}</Button>}>
      <div className="mcp-add">
        <p>{t('mcp.addIntro')}</p>
        <section aria-label={t('mcp.addImport')}><h3>{t('mcp.addImport')}</h3><ImportPrompt /></section>
        <section aria-label={t('mcp.addHttp')}><h3>{t('mcp.addHttp')}</h3><Prompt label={t('mcp.copyPrompt')} context={t('mcp.addHttp')} text={t('mcp.promptHttp')} /></section>
        <section aria-label={t('mcp.addStdio')}><h3>{t('mcp.addStdio')}</h3><Prompt label={t('mcp.copyPrompt')} context={t('mcp.addStdio')} text={t('mcp.promptStdio')} /></section>
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
