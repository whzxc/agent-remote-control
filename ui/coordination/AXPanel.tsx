import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { IconButton } from '../components/kit/button';
import { LoadingIndicator, SearchInput } from '../components/ui';
import { PanelFooter } from '../components/ui/Panel';
import { RecordDetail, RecordEmpty, RecordSurface } from '../components/ui/RecordDetail';
import { useCopyState } from '../components/ui/useCopyState';
import { t, locale } from '../i18n';
import { connector } from '../state/connector';
import { createStore } from '../state/store';
import { useAppNow } from '../state/appEnvironment';
import { dayKey, relativeTime } from '../lib/relativeTime';
import { axClosed, axDecision, axRows, axStatus, type AXActor, type AXEntry } from './axModel';
import { axObservation, refreshAX, resetAX } from './axState';
import { AXBoardFooterContent, AXBoardView, AXEntryRowView } from './AXBoardView';
import { AXEntryDetailView, AXStatusBadgeView, type AXEvidenceItem, type AXHistoryItem } from './AXEntryDetailView';

export const axSelection = createStore<string | undefined>(undefined);
const axView = createStore({ closed: false, search: '' });
let observedCore: string | undefined;

const stamp = (value?: string | null) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString(locale.get(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : '—';
const shortId = (id: string) => (/^ax-[0-9a-f]{8}-/i.test(id) ? id.slice(0, 11) : id);

function Status({ entry }: { entry: AXEntry }) {
  const status = axStatus(entry);
  return <AXStatusBadgeView status={status} label={t(`center.ax.status.${status}`)} />;
}

function CopyValue({ value, label, compact = false }: { value: string; label: string; compact?: boolean }) {
  const { copied, error, copy } = useCopyState();
  return (
    <>
      <IconButton
        icon={copied ? Check : Copy}
        label={copied ? t('copied') : label}
        compact={compact}
        onClick={() => { void copy(value); }}
      />
      {copied && <span className="sr-only" role="status">{t('copied')}</span>}
      {error && <span role="alert" className="text-meta text-danger">{error}</span>}
    </>
  );
}

export default function AXPanel() {
  const data = axObservation.use(), selectedId = axSelection.use(), view = axView.use();
  const connection = connector.use(), language = locale.use(), now = useAppNow(30_000);
  const [pagination, setPagination] = useState({ view, count: view.closed ? 4 : 5 });
  const limit = pagination.view === view ? pagination.count : view.closed ? 4 : 5;
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

  useEffect(() => {
    if (selectedId) heading.current?.focus();
    else if (previousSelection.current) {
      if (list.current) list.current.scrollTop = scroll.current;
      (document.getElementById(trigger.current) ?? list.current)?.focus();
    }
    previousSelection.current = selectedId;
  }, [selectedId]);

  const source = (actor: AXActor) =>
    actor.type === 'local-authority' ? t('center.ax.local')
      : actor.type === 'source' ? connection.sources.find(row => row.id === actor.sourceId)?.label ?? actor.sourceId ?? t('center.unknown')
        : actor.type === 'arc' ? 'ARC' : actor.type === 'seed' ? t('center.ax.import') : actor.type;
  const ago = (value?: string | null) => relativeTime(value, now, language, t('time.justNow'));
  const rows = axRows(data.entries, view.closed, view.search);
  const closedCount = data.entries.filter(axClosed).length;
  const selected = data.entries.find(entry => entry.id === selectedId);
  const severity = (entry: AXEntry) => (entry.severity ? t(`center.ax.severity.${entry.severity}`) : '');
  const open = (entry: AXEntry, id: string) => {
    scroll.current = list.current?.scrollTop ?? 0;
    trigger.current = id;
    axSelection.set(entry.id);
  };

  const badgeTime = (entry: AXEntry) => {
    if (!axClosed(entry)) return ago(entry.lastSeenAt);
    const at = axDecision(entry)?.at;
    let time = '—';
    if (at) {
      const date = new Date(at), key = dayKey(at);
      time = key === dayKey(new Date(now).toISOString())
        ? `${t('center.today')} ${date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}`
        : key === dayKey(new Date(now - 86400000).toISOString())
          ? t('center.yesterday')
          : date.toLocaleDateString(language, { month: 'short', day: 'numeric' });
    }
    return t('center.ax.closedAt', { time });
  };

  function detail(entry: AXEntry) {
    const status = axStatus(entry);
    const decision = axDecision(entry), result = decision?.detail;
    const rawEvidence = [...entry.evidence ?? [], ...result?.verification ?? []];
    const unique = [...new Map(rawEvidence.map(item => [JSON.stringify([item.kind, item.id, item.references, item.coreBuild, item.observedAt]), item])).values()];
    const evidence: AXEvidenceItem[] = unique.map((item, index) => {
      const references = item.references?.map(ref => ref.id).join(' · ');
      const value = item.id ?? references ?? item.coreBuild ?? item.desktopBuild ?? stamp(item.observedAt);
      const kindLabel = ['receipt', 'thread', 'observation', 'import', 'candidate-observation'].includes(item.kind) ? t(`center.ax.evidence.${item.kind}`) : item.kind;
      const itemStatus = item.state ? t(`center.state.${item.state}`) : item.availability ? t(`center.ax.availability.${item.availability}`) : undefined;
      return {
        key: `${index}-${value}`,
        kind: item.kind === 'receipt' ? 'receipt' : item.kind === 'thread' ? 'thread' : 'file',
        kindLabel,
        value,
        status: itemStatus,
      };
    });
    const history: AXHistoryItem[] = entry.history.map((item, index) => ({
      key: `${item.revision}-${index}`,
      resolved: ['fix', 'document'].includes(item.action),
      timeLabel: stamp(item.at),
      dateTime: item.at,
      summary: `${source(item.actor)} · ${t(`center.ax.action.${item.action}`)}`,
      reason: item !== decision ? item.detail?.reason : undefined,
    }));

    return (
      <AXEntryDetailView
        DetailContainer={RecordDetail}
        ariaLabel={t('center.recordDetail')}
        id={entry.id}
        status={status}
        statusLabel={t(`center.ax.status.${status}`)}
        severityLabel={severity(entry) || undefined}
        symptom={entry.symptom}
        metaLine={[
          t('center.ax.occurrences', { count: entry.occurrenceCount }),
          source(entry.source),
          entry.lastSeenAt && t('center.ax.lastSeen', { time: stamp(entry.lastSeenAt) }),
        ].filter(Boolean).join(' · ')}
        backLabel={t('center.ax.list')}
        onBack={() => axSelection.set(undefined)}
        copyIdAction={<CopyValue value={entry.id} label={t('center.ax.copyId')} />}
        headingRef={heading}
        symptomHeading={t('center.ax.symptom')}
        expectedHeading={t('center.ax.expected')}
        expected={entry.expected}
        reproductionHeading={t('center.ax.reproduction')}
        reproductionHints={entry.reproductionHints}
        resolution={decision ? {
          heading: t('center.ax.result'),
          body: result?.reason ?? t(`center.ax.action.${decision.action}`),
          commitLabel: t('center.ax.commit'),
          commit: result?.commit,
          copyCommitAction: result?.commit ? <CopyValue value={result.commit} label={t('center.ax.copyCommit')} compact /> : undefined,
          document: result?.document,
          mergedIntoLabel: t('center.ax.mergedInto'),
          mergedInto: entry.mergedInto ?? undefined,
        } : undefined}
        evidenceHeading={t('center.ax.evidence')}
        evidence={evidence}
        historyHeading={t('center.ax.history')}
        history={history}
      />
    );
  }

  const footerLabel = data.observedAt
    ? limit < rows.length
      ? t('center.ax.showing', { count: Math.min(limit, rows.length), total: rows.length })
      : t('center.ax.updatedAt', { time: new Date(data.observedAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' }) })
    : '';

  return (
    <AXBoardView
      Surface={RecordSurface}
      EmptyContainer={RecordEmpty}
      loading={data.loading}
      observed={Boolean(data.observedAt)}
      loadingSlot={<LoadingIndicator label={t('loading')} />}
      error={data.error || undefined}
      errorTitle={t('center.unavailable')}
      retryLabel={t('retry')}
      onRetry={() => void refreshAX()}
      selectedContent={selectedId && selected ? detail(selected) : undefined}
      notFound={Boolean(selectedId && !selected)}
      notFoundMessage={t('center.ax.notFound')}
      backLabel={t('center.ax.list')}
      onBack={() => axSelection.set(undefined)}
      filterLabel={t('center.ax.filter')}
      filterValue={view.closed ? 'closed' : 'open'}
      filterOptions={[
        { value: 'open', label: t('center.ax.open', { count: data.observedAt ? data.entries.length - closedCount : '—' }) },
        { value: 'closed', label: t('center.ax.closed', { count: data.observedAt ? closedCount : '—' }) },
      ]}
      onFilterChange={value => axView.set(old => ({ ...old, closed: value === 'closed' }))}
      searchPlaceholder={t('center.ax.search')}
      searchSlot={
        <SearchInput
          placeholder={t('center.ax.search')}
          value={view.search}
          onChange={event => axView.set(old => ({ ...old, search: event.target.value }))}
          className="w-full @[480px]:w-[240px] @[480px]:max-w-[45%]"
        />
      }
      listRef={list}
      empty={!rows.length && Boolean(data.observedAt)}
      emptyMessage={t('center.emptyBoard')}
      footer={data.observedAt ? (
        <PanelFooter className="ax-footer w-full">
          <AXBoardFooterContent
            label={footerLabel}
            moreLabel={limit < rows.length ? t('center.ax.more') : undefined}
            onMore={() => setPagination({ view, count: limit + 50 })}
          />
        </PanelFooter>
      ) : undefined}
    >
      {rows.slice(0, limit).map(entry => {
        const id = `ax-row-${entry.id}`;
        const status = axStatus(entry);
        return (
          <AXEntryRowView
            key={entry.id}
            id={id}
            shortId={shortId(entry.id)}
            fullId={entry.id}
            title={entry.symptom}
            meta={[
              !axClosed(entry) && severity(entry),
              t('center.ax.occurrences', { count: entry.occurrenceCount }),
              source(entry.source),
              badgeTime(entry),
            ].filter(Boolean).join(' · ')}
            status={status}
            statusLabel={t(`center.ax.status.${status}`)}
            statusNode={<Status entry={entry} />}
            onClick={() => open(entry, id)}
          />
        );
      })}
    </AXBoardView>
  );
}
