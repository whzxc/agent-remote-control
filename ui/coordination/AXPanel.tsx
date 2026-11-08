import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, ChevronDown, ChevronRight, CircleDot, Copy, GitCommitHorizontal, Inbox, Lightbulb, ListChecks, Minus, ReceiptText, MessageSquare, FileText, X } from 'lucide-react';
import { Button, Icon, IconButton, LoadingIndicator, Notice, SearchInput, SingleChoice } from '../components/ui';
import { Card } from '../components/ui/card';
import { t, locale } from '../i18n';
import { copyText } from '../platform';
import { connector } from '../state/connector';
import { createStore } from '../state/store';
import { useAppNow } from '../state/appEnvironment';
import { dayKey, relativeTime } from '../lib/relativeTime';
import { axClosed, axDecision, axRows, axStatus, type AXActor, type AXEntry } from './axModel';
import { axObservation, refreshAX, resetAX } from './axState';
import './ax.css';

export const axSelection = createStore<string | undefined>(undefined);
const axView = createStore({ closed: false, search: '' });
let observedCore: string | undefined;
const stamp = (value?: string | null) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(locale.get(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
const shortId = (id: string) => /^ax-[0-9a-f]{8}-/i.test(id) ? id.slice(0, 11) : id;
const icons = { open: CircleDot, triaged: ListChecks, candidate: Lightbulb, fix: Check, document: Check, wontfix: Minus, merged: Minus, rejected: X, closed: Check };

function Status({ entry }: { entry: AXEntry }) {
  const status = axStatus(entry);
  return <span className="ax-status" data-status={status}><Icon icon={icons[status as keyof typeof icons] ?? CircleDot} size={14} />{t(`center.ax.status.${status}`)}</span>;
}
function CopyValue({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false), [error, setError] = useState('');
  useEffect(() => { if (copied) { const timer = setTimeout(() => setCopied(false), 2000); return () => clearTimeout(timer); } }, [copied]);
  return <><IconButton icon={copied ? Check : Copy} label={copied ? t('copied') : label} compact={compact} onClick={() => { setError(''); void copyText(value).then(() => setCopied(true), () => setError(t('copyFailedSelectAndCopyTheTextManually'))); }} />
    {copied && <span className="sr-only" role="status">{t('copied')}</span>}{error && <span role="alert" className="ax-copy-error">{error}</span>}</>;
}

export default function AXPanel() {
  const data = axObservation.use(), selectedId = axSelection.use(), view = axView.use();
  const connection = connector.use(), language = locale.use(), now = useAppNow(30_000);
  const [limit, setLimit] = useState(view.closed ? 4 : 5);
  const list = useRef<HTMLDivElement>(null), scroll = useRef(0), trigger = useRef('');
  const heading = useRef<HTMLHeadingElement>(null), previousSelection = useRef(selectedId);
  const core = connection.status?.core.backendSession;
  useEffect(() => {
    if (core && observedCore && core !== observedCore) { resetAX(); axSelection.set(undefined); }
    if (core) observedCore = core;
    const read = () => { if (!document.hidden) void refreshAX(); };
    read(); const timer = setInterval(read, 15000);
    document.addEventListener('visibilitychange', read);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', read); };
  }, [core]);
  useEffect(() => { setLimit(view.closed ? 4 : 5); }, [view.closed, view.search]);
  useEffect(() => {
    if (selectedId) heading.current?.focus();
    else if (previousSelection.current) {
      if (list.current) list.current.scrollTop = scroll.current;
      (document.getElementById(trigger.current) ?? list.current)?.focus();
    }
    previousSelection.current = selectedId;
  }, [selectedId]);
  const source = (actor: AXActor) => actor.type === 'local-authority' ? t('center.ax.local') : actor.type === 'source'
    ? connection.sources.find(row => row.id === actor.sourceId)?.label ?? actor.sourceId ?? t('center.unknown')
    : actor.type === 'arc' ? 'ARC' : actor.type === 'seed' ? t('center.ax.import') : actor.type;
  const ago = (value?: string | null) => relativeTime(value, now, language, t('time.justNow'));
  const rows = axRows(data.entries, view.closed, view.search);
  const closedCount = data.entries.filter(axClosed).length;
  const selected = data.entries.find(entry => entry.id === selectedId);
  const severity = (entry: AXEntry) => entry.severity ? t(`center.ax.severity.${entry.severity}`) : '';
  const open = (entry: AXEntry, id: string) => { scroll.current = list.current?.scrollTop ?? 0; trigger.current = id; axSelection.set(entry.id); };
  const badgeTime = (entry: AXEntry) => {
    if (!axClosed(entry)) return ago(entry.lastSeenAt);
    const at = axDecision(entry)?.at;
    let time = '—';
    if (at) {
      const date = new Date(at), key = dayKey(at);
      time = key === dayKey(new Date(now).toISOString()) ? `${t('center.today')} ${date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}`
        : key === dayKey(new Date(now - 86400000).toISOString()) ? t('center.yesterday') : date.toLocaleDateString(language, { month: 'short', day: 'numeric' });
    }
    return t('center.ax.closedAt', { time });
  };
  function evidenceRows(entry: AXEntry) {
    const evidence = [...entry.evidence ?? [], ...axDecision(entry)?.detail?.verification ?? []];
    const unique = [...new Map(evidence.map(item => [JSON.stringify([item.kind, item.id, item.references, item.coreBuild, item.observedAt]), item])).values()];
    return unique.map((item, index) => {
      const references = item.references?.map(ref => ref.id).join(' · ');
      const value = item.id ?? references ?? item.coreBuild ?? item.desktopBuild ?? stamp(item.observedAt);
      const kind = ['receipt', 'thread', 'observation', 'import', 'candidate-observation'].includes(item.kind) ? t(`center.ax.evidence.${item.kind}`) : item.kind;
      const status = item.state ? t(`center.state.${item.state}`) : item.availability ? t(`center.ax.availability.${item.availability}`) : '';
      return <div key={index} className="ax-evidence-row"><Icon icon={item.kind === 'receipt' ? ReceiptText : item.kind === 'thread' ? MessageSquare : FileText} size={14} />
        <span>{kind}</span><code title={value}>{value}</code>{status && <span className="ax-evidence-state">{status}</span>}</div>;
    });
  }
  function detail(entry: AXEntry) {
    const decision = axDecision(entry), result = decision?.detail;
    return <section className="ax-detail" aria-label={t('center.recordDetail')}>
      <div className="ax-back"><Button variant="ghost" onClick={() => axSelection.set(undefined)}><Icon icon={ArrowLeft} />{t('center.ax.list')}</Button>
        <CopyValue value={entry.id} label={t('center.ax.copyId')} /></div>
      <header className="ax-detail-heading">
        <div className="ax-facts"><code>{entry.id}</code><Status entry={entry} />{severity(entry) && <span>{severity(entry)}</span>}</div>
        <h3 ref={heading} tabIndex={-1}>{entry.symptom}</h3>
        <p>{[t('center.ax.occurrences', { count: entry.occurrenceCount }), source(entry.source), entry.lastSeenAt && t('center.ax.lastSeen', { time: stamp(entry.lastSeenAt) })].filter(Boolean).join(' · ')}</p>
      </header>
      <div className="ax-description">
        {[['symptom', entry.symptom], ['expected', entry.expected]].map(([key, value]) => <section key={key}><h4>{t(`center.ax.${key}`)}</h4><p>{value}</p></section>)}
      </div>
      {entry.reproductionHints && <section><h4>{t('center.ax.reproduction')}</h4><p>{entry.reproductionHints}</p></section>}
      {decision && <Card asChild padded className="ax-resolution"><section>
        <h4>{t('center.ax.result')}</h4>
        {result?.reason ? <p>{result.reason}</p> : <p>{t(`center.ax.action.${decision.action}`)}</p>}
        {result?.commit && <div className="ax-commit"><Icon icon={GitCommitHorizontal} size={14} /><span>{t('center.ax.commit')}</span><code>{result.commit}</code><CopyValue value={result.commit} label={t('center.ax.copyCommit')} compact /></div>}
        {result?.document && <p className="ax-document"><Icon icon={FileText} size={14} />{result.document}</p>}
        {entry.mergedInto && <p><span>{t('center.ax.mergedInto')}</span> <code>{entry.mergedInto}</code></p>}
      </section></Card>}
      {(!!entry.evidence?.length || !!result?.verification?.length) && <section><h4>{t('center.ax.evidence')}</h4><div className="ax-evidence">{evidenceRows(entry)}</div></section>}
      <section className="ax-history"><h4>{t('center.ax.history')}</h4>
        {entry.history.map((item, index) => <div className="ax-history-item" key={`${item.revision}-${index}`}>
          <div><Icon icon={['fix', 'document'].includes(item.action) ? Check : CircleDot} size={14} /><time dateTime={item.at}>{stamp(item.at)}</time><span>{`${source(item.actor)} · ${t(`center.ax.action.${item.action}`)}`}</span></div>
          {item !== decision && item.detail?.reason && <p>{item.detail.reason}</p>}
        </div>)}
      </section>
    </section>;
  }
  return <div className="ax-panel" aria-busy={data.loading}>
    {data.error && <Notice tone="danger" title={t('center.unavailable')} action={<Button busy={data.loading} onClick={() => void refreshAX()}>{t('retry')}</Button>}>{data.error}</Notice>}
    {data.loading && !data.observedAt && <LoadingIndicator label={t('loading')} />}
    {selectedId ? selected ? detail(selected) : <div className="center-empty"><Button onClick={() => axSelection.set(undefined)}>{t('center.ax.list')}</Button><p role="status">{t('center.ax.notFound')}</p></div> : <>
      <div className="ax-toolbar">
        <SingleChoice label={t('center.ax.filter')} disabled={data.loading && !data.observedAt} value={view.closed ? 'closed' : 'open'} compact onChange={value => axView.set(old => ({ ...old, closed: value === 'closed' }))}
          options={[{ value: 'open', label: t('center.ax.open', { count: data.observedAt ? data.entries.length - closedCount : '—' }) }, { value: 'closed', label: t('center.ax.closed', { count: data.observedAt ? closedCount : '—' }) }]} />
        <SearchInput placeholder={t('center.ax.search')} value={view.search} onChange={event => axView.set(old => ({ ...old, search: event.target.value }))} />
      </div>
      <div ref={list} className="ax-list" tabIndex={-1}>
        {rows.slice(0, limit).map(entry => {
          const id = `ax-row-${entry.id}`;
          return <Card asChild padded key={entry.id} className="ax-row"><button type="button" id={id} onClick={() => open(entry, id)} aria-labelledby={`${id}-title`} aria-describedby={`${id}-meta ${id}-status`}>
            <span className="center-glyph"><Icon icon={Lightbulb} /></span>
            <span className="ax-row-body"><span className="ax-row-title"><code title={entry.id}>{shortId(entry.id)}</code><strong id={`${id}-title`}>{entry.symptom}</strong></span>
              <span id={`${id}-meta`} className="ax-row-meta">{[!axClosed(entry) && severity(entry), t('center.ax.occurrences', { count: entry.occurrenceCount }), source(entry.source), badgeTime(entry)].filter(Boolean).join(' · ')}</span></span>
            <span id={`${id}-status`}><Status entry={entry} /></span><Icon icon={ChevronRight} className="center-row-go" />
          </button></Card>;
        })}
        {!rows.length && data.observedAt && <div className="center-empty" role="status"><Icon icon={Inbox} size={20} /><p>{t('center.emptyBoard')}</p></div>}
      </div>
      {data.observedAt && <footer className="ax-footer"><span>{limit < rows.length ? t('center.ax.showing', { count: Math.min(limit, rows.length), total: rows.length }) : t('center.ax.updatedAt', { time: new Date(data.observedAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) })}</span>
        {limit < rows.length && <Button variant="ghost" onClick={() => setLimit(old => old + 50)}><Icon icon={ChevronDown} />{t('center.ax.more')}</Button>}</footer>}
    </>}
  </div>;
}
