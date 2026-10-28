import { useAppNow } from "../state/appEnvironment";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { tasks, type TaskRuntime } from "../state/tasks";
import { trackedActivity } from "../state/activityBubbles";
import { activitySections } from "../state/activitySections";
import { agentActivity } from "../state/activity";
import { selectAgentPanel } from "../state/overviewPanels";
import { navigation } from "../state/navigation";
import { useAccounts } from "../state/accounts";
import { connector } from "../state/connector";
import { sourceDispatches, dispatchState, isLatestDispatch } from "../state/sourceDispatch";
import { PhaseTile } from "./activity";
import { Empty, Icon, Notice } from "./ui";

export default function SourceDispatches({ sourceId }: { sourceId: string }) {
  const account = useAccounts().items.find(account => account.sources.includes(sourceId));
  const { sources } = connector.use(), product = sources.find(source => source.id === sourceId)?.product;
  const historyIds = (account?.sources ?? [sourceId]).filter(id => !product || sources.some(source => source.id === id && source.product === product));
  const now = useAppNow(60_000), language = locale.use();
  const tracked = trackedActivity.use();
  const { records, error } = tasks.use(), { snapshot } = agentActivity.use();
  const [runtimes, setRuntimes] = useState<Record<string, TaskRuntime>>({});
  const [visible, setVisible] = useState(8);
  const more = useRef<HTMLDivElement>(null);
  const stateOf = (record: typeof records[number]) => {
    const id = record.threadId || record.task.threadId;
    const latest = isLatestDispatch(record, records);
    return dispatchState(record, latest && id ? runtimes[id] ?? record.runtime : undefined, latest ? snapshot?.agents[record.agent ?? "codex"]?.sessions.find(s => s.id === id) : undefined);
  };
  const unreadOf = (record: typeof records[number]) => {
    if (!isLatestDispatch(record, records)) return;
    const id = record.threadId || record.task.threadId;
    return tracked[record.agent ?? 'codex']?.find(session => session.id === id
      && session.endedAt !== undefined && session.readAt === undefined
      && (!record.turnId || !session.turnId || record.turnId === session.turnId));
  };
  const dispatches = [...new Map(historyIds.flatMap(id => sourceDispatches(records, id)).map(record => [record.requestId, record])).values()];
  const sections = activitySections(dispatches, now, record => Date.parse(record.createdAt) || 0, record => {
    const state = stateOf(record);
    return state === 'pending' ? 'attention' : state === 'running' ? 'running' : unreadOf(record) ? 'unread' : undefined;
  });
  const rows = sections.flatMap(section => section.entries).slice(0, visible);
  const visibleIds = new Set(rows.map(record => record.requestId));
  useEffect(() => { setRuntimes({}); setVisible(8); }, [sourceId]);
  useEffect(() => {
    const marker = more.current;
    if (!marker || visible >= dispatches.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(count => count + 8);
    }, { root: marker.closest(".agent-view-scroll, .workspace"), rootMargin: "0px 0px 120px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [visible, dispatches.length]);
  const ids = [...new Set(rows.filter(r => isLatestDispatch(r, records)).map(r => r.threadId || r.task.threadId).filter((id): id is string => !!id))];
  useEffect(() => {
    let stopped = false, reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      for (let i = 0; i < ids.length && !stopped; i += 4) await Promise.all(ids.slice(i, i + 4).map(async id => {
        try {
          const runtime = await api<TaskRuntime>(`tasks/runtime/${encodeURIComponent(id)}`);
          if (!stopped) setRuntimes(old => ({ ...old, [id]: runtime }));
        } catch {
          if (!stopped) setRuntimes(old => ({ ...old, [id]: { runtimeStatus: "unknown", observedAt: "", stale: true } }));
        }
      }));
      reading = false;
    };
    void read(); const timer = setInterval(() => void read(), 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, [sourceId, ids.slice().sort().join(",")]);
  const empty = !rows.length && !error;
  return <div className={empty ? 'activity-task-list agent-conversations' : 'source-dispatch-list'} data-empty={empty || undefined}>
    {error && <Notice>{error}</Notice>}
    {sections.map(({ id: groupId, date, entries }) => {
      const shown = entries.filter(record => visibleIds.has(record.requestId));
      if (!shown.length) return null;
      const label = date === undefined ? t(`agentPanel.${groupId}`) : new Date(date).toLocaleDateString(language, { month: 'short', day: 'numeric', weekday: 'short' });
      return <section className="agent-task-section" key={groupId} aria-label={label}>
        <h3 className="agent-task-section-heading" data-attention={groupId === 'attention' || undefined}>
          {label}<span className="agent-section-count">{entries.length}</span>
        </h3>
        <div className="agent-task-section-rows">{shown.map(record => {
          const id = record.threadId || record.task.threadId;
          const agent = record.agent ?? "codex", unread = unreadOf(record);
          const latest = isLatestDispatch(record, records);
          const live = latest ? snapshot?.agents[record.agent ?? "codex"]?.sessions.find(s => s.id === id) : undefined;
          const runtime = latest && id ? runtimes[id] ?? record.runtime : undefined;
          const state = dispatchState(record, runtime, live);
          const title = record.task.title || live?.title || runtime?.title || record.task.prompt.split("\n")[0] || t("taskRequest");
          const phase = state === "pending" ? "interaction" : state === "running" ? live?.phase ?? "thinking" : "idle";
          const canOpen = !!id && (unread || (state === "running" || state === "pending") && (live || runtime && !runtime.stale));
          return <button key={record.requestId} className="source-dispatch-row" disabled={!canOpen} data-state={state} onClick={() => {
            if (!id || !canOpen) return;
            selectAgentPanel({ type: "task", agent, session: live ? { ...live, orderAt: Date.parse(record.createdAt) } : unread ? { ...unread, orderAt: Date.parse(record.createdAt) } : {
              id, source: "codex-thread", title, phase, headline: title, phaseSince: null, timeline: true,
              project: record.task.project || record.task.directory, startedAt: record.createdAt, orderAt: Date.parse(record.createdAt),
            } });
            navigation.set(old => ({ ...old, page: "overview" }));
          }}>
            <PhaseTile phase={phase} completed={state === "completed"} animated={false} />
            <span><strong>{title}</strong><span className="source-dispatch-meta">{record.agent ?? "Codex"} · <span>{t(`sourcePanel.${state}`)}</span></span></span>
            {canOpen && <Icon icon={ChevronRight} />}
          </button>;
        })}</div>
      </section>;
    })}
    {empty && <Empty icon={MessagesSquare}>{t("sourcePanel.noRecords")}</Empty>}
    {visible < dispatches.length && <div ref={more} className="source-dispatch-more" aria-hidden="true" />}
  </div>;
}
