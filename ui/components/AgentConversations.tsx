
import { TaskDateHeading } from "./timeline/TaskPresentation";
import { taskExecution, taskExecutions } from "../state/taskExecution";
import { activityApprovals } from "../state/activity";
import { pendingSessions } from "../state/taskInteractions";
import { useAppNow } from "../state/appEnvironment";
import { MessagesSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";
import type { AgentActivitySession, AgentConversation, AgentConversationPage } from "../types";
import { agentActivity } from "../state/activity";
import { trackedActivity } from "../state/activityBubbles";
import { selectAgentPanel } from "../state/overviewPanels";
import { localTaskDay, previewHomepageTask, type TrackedActivity } from "../state/activityModel";
import { activitySections } from "../state/activitySections";
import { executionStatus } from "../state/taskExecutionModel";
import { presentTaskState, taskStatusEvidence } from "../state/taskProjection";
import { Button, Empty, Loading, Notice } from "./ui";
import { dockLoadingDelay } from "./useDockOpening";
import { TaskCard, localTaskCard } from "./ui/TaskCard";

export const readConversationPage = (agent: string, cursor?: string) => api<AgentConversationPage>("agents/conversations", "POST", { agent, limit: 20, ...(cursor ? { cursor } : {}) });
export type InitialAgentHistory = {
  request: Promise<AgentConversationPage>;
  result?: { page: AgentConversationPage } | { error: string };
  timedOut?: boolean;
};

export default function AgentConversations({ agent, active, initial }: {
  agent: string; active: boolean; initial?: InitialAgentHistory;
}) {
  const language = locale.use();
  taskExecutions.use();
  const submissions = activityApprovals.use();
  const { snapshot } = agentActivity.use();
  const tracked = trackedActivity.use(), retained = tracked[agent] ?? [];
  const unread = new Set(retained.filter(session => session.endedAt !== undefined && session.readAt === undefined).map(session => session.id));
  const [observed, setObserved] = useState<Record<string, AgentActivitySession>>({});
  const initialPage = initial?.result && "page" in initial.result ? initial.result.page : undefined;
  const initialError = initial?.result && "error" in initial.result ? initial.result.error : "";
  const [rows, setRows] = useState<AgentConversation[]>(initialPage?.data ?? []), [next, setNext] = useState<string | null>(initialPage?.nextCursor ?? null);
  const [cursor, setCursor] = useState<string>(), [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(!initial?.result), [error, setError] = useState(initialError);
  const firstRead = useRef(initial);
  const loaded = useRef<string | undefined>(initialPage ? "" : undefined), marker = useRef<HTMLDivElement>(null);
  const pending = useRef<{ key: string; request: Promise<AgentConversationPage> } | undefined>(undefined);
  const live = new Map(snapshot?.agents[agent]?.sessions.map(session => [session.id, { ...session, interaction: pendingSessions(agent, session, taskExecution(agent, session.id)?.interactions ?? [], submissions)[0]?.interaction }]) ?? []);
  const now = useAppNow(active && live.size ? 1000 : 60000);
  useEffect(() => {
    const sessions = [...(tracked[agent] ?? []), ...(snapshot?.agents[agent]?.sessions ?? [])];
    if (sessions.length) setObserved(old => {
      const changed = sessions.filter(session => JSON.stringify(old[session.id]) !== JSON.stringify(session));
      return changed.length ? { ...old, ...Object.fromEntries(changed.map(session => [session.id, session])) } : old;
    });
  }, [agent, snapshot, tracked]);
  useEffect(() => {
    const key = cursor ?? "";
    if (!active || loaded.current === key || (!key && !retry && initialError)) return;
    let stopped = false;
    setLoading(true); setError("");
    const request = pending.current?.key === key ? pending.current.request
      : (!key && !retry ? firstRead.current?.request : undefined) ?? readConversationPage(agent, cursor);
    pending.current = { key, request };
    void request
      .then(page => {
        if (stopped) return;
        loaded.current = key;
        setRows(old => [...new Map([...old, ...page.data].map(row => [row.id, row])).values()]
          .sort((a, b) => (Date.parse(b.createdAt ?? "") || 0) - (Date.parse(a.createdAt ?? "") || 0) || b.id.localeCompare(a.id)));
        setNext(page.nextCursor);
      }).catch(error => { if (!stopped) setError(String(error)); })
      .finally(() => {
        if (pending.current?.request === request) pending.current = undefined;
        if (!stopped) setLoading(false);
      });
    return () => { stopped = true; };
  }, [agent, active, cursor, retry, initialError]);
  useEffect(() => {
    const node = marker.current;
    if (!active || !node || !next || loading || error) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setCursor(next);
    }, { root: node.closest(".agent-view-scroll"), rootMargin: "0px 0px 160px 0px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [active, next, loading, error]);
  const sessions = new Map<string, TrackedActivity>(rows.map(conversation => [conversation.id, {
    id: conversation.id, source: conversation.source === "native" ? "transcript" : conversation.source, status: conversation.status, title: conversation.title || undefined, phase: "idle", observed: false, phaseSince: null,
    headline: "", startedAt: conversation.createdAt, turnId: conversation.turnId, turnStartedAt: conversation.turnStartedAt, turnEndedAt: conversation.turnEndedAt,
    turnDurationMs: conversation.turnDurationMs, project: conversation.project, projectName: conversation.projectName,
    dispatchSummary: conversation.dispatchSummary ?? undefined, turnCount: conversation.turnCount ?? undefined,
    nativeSessionId: conversation.nativeSessionId ?? undefined, open: conversation.open,
    timeline: true, orderAt: Date.parse(conversation.createdAt ?? "") || 0, conversation: true,
  }]));
  for (const remembered of [...Object.values(observed), ...retained, ...live.values()]) {
    const current = live.get(remembered.id), history = sessions.get(remembered.id);
    const session = current ? { ...current, observed: true } : { ...remembered, observed: false, phase: "idle" as const, phaseSince: null, interaction: undefined };
    sessions.set(session.id, { ...history, ...session,
      startedAt: history?.startedAt ?? session.startedAt,
      title: session.title || history?.title,
      project: session.project ?? history?.project,
      projectName: session.projectName ?? (!session.project || session.project === history?.project ? history?.projectName : undefined),
      status: current ? undefined : (remembered as TrackedActivity).status ?? history?.status,
      dispatchSummary: session.dispatchSummary ?? history?.dispatchSummary,
      turnCount: session.turnCount === undefined ? history?.turnCount : Math.max(session.turnCount, history?.turnCount ?? 0),
      orderAt: history?.orderAt || Date.parse(session.startedAt ?? "") || 0,
      conversation: history?.conversation || session.source !== "transcript",
    });
  }
  const visibleSessions = [...sessions.values()].sort((a, b) => b.orderAt - a.orderAt || b.id.localeCompare(a.id));
  const sections = activitySections(visibleSessions, now, session => session.orderAt,
    session => live.has(session.id) ? session.interaction ? 'attention' : 'running' : unread.has(session.id) ? 'unread' : undefined);
  const today = localTaskDay(now);
  const empty = !loading && !error && !visibleSessions.length && !next;
  const initialLoading = active && !error && ((!cursor && loading) || (!visibleSessions.length && (loading || next !== null)));
  const [showLoading, setShowLoading] = useState(!!initial?.timedOut);
  useEffect(() => {
    if (!initialLoading) { setShowLoading(false); return; }
    const timer = setTimeout(() => setShowLoading(true), dockLoadingDelay);
    return () => clearTimeout(timer);
  }, [initialLoading]);
  return <div className="activity-task-list agent-conversations" data-empty={empty || undefined} aria-busy={active && loading}>
    {sections.map(({ id, date, entries }) => {
      const label = date === undefined ? t(`agentPanel.${id}`) : new Date(date).toLocaleDateString(language, { month: 'short', day: 'numeric', weekday: 'short' });
      return entries.length > 0 && <section className="agent-task-section" key={id} aria-label={label}>
        <TaskDateHeading attention={id === "attention"}>
          {`${label} · ${entries.length}`}
        </TaskDateHeading>
        <div className="agent-task-section-rows">{entries.map(session => {
          const status = taskStatusEvidence(executionStatus(taskExecution(agent, session.id), session.turnId), session.status);
          const state = presentTaskState(status ?? undefined, live.has(session.id), !!session.interaction);
          const task = localTaskCard(agent, { ...session, status }, state === 'needsYou' ? 'needs-me' : state === 'running' ? 'running' : unread.has(session.id) ? 'unread' : 'recent');
          return <TaskCard key={session.id} task={task} now={now} form={previewHomepageTask(task, today) ? 'detail' : 'summary'}
            description={t(`detail.state.${state}`)} trigger={{ 'data-activity-session': task.key }}
            onOpen={() => selectAgentPanel({ type: "task", agent, session })} />;
        })}</div>
      </section>;
    })}
    {initialLoading && showLoading && <Loading />}
    {error && <Notice action={<Button onClick={() => setRetry(value => value + 1)}>{t("retry")}</Button>}>{error}</Notice>}
    {empty && <Empty inset={false} icon={MessagesSquare}>{t("agentPanel.noConversations")}</Empty>}
    {next && <div ref={marker} className="agent-conversation-more" aria-hidden="true" />}
  </div>;
}
