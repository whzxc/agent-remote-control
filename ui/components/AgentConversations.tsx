import { taskExecution, taskExecutions } from "../state/taskExecution";
import { activityApprovals } from "../state/activity";
import { pendingSessions } from "../state/taskInteractions";
import { useAppNow } from "../state/appEnvironment";
import { MessagesSquare } from "lucide-react";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "../api";
import { locale, t } from "../i18n";
import type { AgentActivitySession, AgentConversation, AgentConversationPage, ProviderAccount } from "../types";
import { accountOwns } from "../accountPresentation";
import { agentActivity } from "../state/activity";
import { trackedActivity } from "../state/activityBubbles";
import { selectAgentPanel } from "../state/overviewPanels";
import type { TrackedActivity } from "../state/activityModel";
import { activitySections } from "../state/activitySections";
import { taskState } from "../state/taskProjection";
import { ActivityBubbleContent } from "./ActivityBubbles";
import { Button, Empty, Loading, Notice } from "./ui";

const ConversationRow = memo(function ConversationRow({ agent, session, live, now, index }: {
  agent: string; session: TrackedActivity; live: boolean; now: number; index: number;
}) {
  return <button type="button" className={`activity-bubble agent-conversation-row ${session.interaction ? "needs-attention" : ""}`}
    data-density="standard" data-timeline-anchor
    style={{ "--row-delay": `${Math.min(index, 5) * 24}ms` } as CSSProperties}
    data-activity-session={JSON.stringify([agent, session.id])}
    aria-label={`${session.title || t("timeline.title")} · ${t("timeline.open")}`}
    aria-description={live ? undefined : t(`detail.state.${taskState(session.status ?? undefined, false)}`)}
    onClick={() => selectAgentPanel({ type: "task", agent, session })}>
    <ActivityBubbleContent agent={agent} session={session} now={now} density="standard" historical={!live} conversationRow />
  </button>;
}, (previous, next) => previous.agent === next.agent && previous.live === next.live && previous.index === next.index
  && (next.live ? previous.now === next.now : new Date(previous.now).getFullYear() === new Date(next.now).getFullYear())
  && JSON.stringify(previous.session) === JSON.stringify(next.session));

export default function AgentConversations({ agent, account, accountId, active }: { agent: string; account?: ProviderAccount; accountId?: string; active: boolean }) {
  const language = locale.use();
  taskExecutions.use();
  const submissions = activityApprovals.use();
  const { snapshot } = agentActivity.use();
  const tracked = trackedActivity.use(), retained = tracked[agent] ?? [];
  const unread = new Set(retained.filter(session => session.endedAt !== undefined && session.readAt === undefined).map(session => session.id));
  const [observed, setObserved] = useState<Record<string, AgentActivitySession>>({});
  const [rows, setRows] = useState<AgentConversation[]>([]), [next, setNext] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string>(), [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  const loaded = useRef<string | undefined>(undefined), marker = useRef<HTMLDivElement>(null);
  const pending = useRef<{ key: string; request: Promise<AgentConversationPage> } | undefined>(undefined);
  const belongs = (session: Pick<TrackedActivity, "agentAccountId" | "dispatchSummary">) => !accountId || (account
    ? accountOwns(account, session.agentAccountId ?? session.dispatchSummary?.agentAccountId)
    : (session.agentAccountId ?? session.dispatchSummary?.agentAccountId) === accountId);
  const live = new Map(snapshot?.agents[agent]?.sessions.filter(belongs).map(session => [session.id, { ...session, interaction: pendingSessions(agent, session, taskExecution(agent, session.id)?.interactions ?? [], submissions)[0]?.interaction }]) ?? []);
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
    if (!active || loaded.current === key) return;
    let stopped = false;
    setLoading(true); setError("");
    const request = pending.current?.key === key ? pending.current.request
      : api<AgentConversationPage>("agents/conversations", "POST", { agent, limit: 20, ...(cursor ? { cursor } : {}) });
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
  }, [agent, active, cursor, retry]);
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
    headline: "", startedAt: conversation.createdAt, project: conversation.project, projectName: conversation.projectName,
    dispatchSummary: conversation.dispatchSummary ?? undefined, turnCount: conversation.turnCount ?? undefined,
    agentAccountId: conversation.agentAccountId ?? conversation.dispatchSummary?.agentAccountId,
    nativeSessionId: conversation.nativeSessionId ?? undefined, open: conversation.open,
    timeline: true, orderAt: Date.parse(conversation.createdAt ?? "") || 0, conversation: true,
  }]));
  for (const remembered of [...Object.values(observed), ...retained, ...live.values()]) {
    const current = live.get(remembered.id), history = sessions.get(remembered.id);
    const session = current ? { ...current, observed: true } : { ...remembered, observed: false, phase: "idle" as const, phaseSince: null, interaction: undefined };
    sessions.set(session.id, { ...history, ...session,
      startedAt: history?.startedAt ?? session.startedAt,
      title: session.title || history?.title,
      status: current ? undefined : (remembered as TrackedActivity).status ?? history?.status,
      dispatchSummary: session.dispatchSummary ?? history?.dispatchSummary,
      agentAccountId: session.agentAccountId ?? history?.agentAccountId,
      turnCount: session.turnCount === undefined ? history?.turnCount : Math.max(session.turnCount, history?.turnCount ?? 0),
      orderAt: history?.orderAt || Date.parse(session.startedAt ?? "") || 0,
      conversation: history?.conversation || session.source !== "transcript",
    });
  }
  const visibleSessions = [...sessions.values()].filter(belongs).sort((a, b) => b.orderAt - a.orderAt || b.id.localeCompare(a.id));
  const sections = activitySections(visibleSessions, now, session => session.orderAt,
    session => live.has(session.id) ? session.interaction ? 'attention' : 'running' : unread.has(session.id) ? 'unread' : undefined);
  const empty = !loading && !error && !visibleSessions.length && !next;
  const initialLoading = active && !error && !visibleSessions.length && (loading || next !== null);
  const [showLoading, setShowLoading] = useState(false);
  useEffect(() => {
    if (!initialLoading) { setShowLoading(false); return; }
    const timer = setTimeout(() => setShowLoading(true), 200);
    return () => clearTimeout(timer);
  }, [initialLoading]);
  return <div className="activity-task-list agent-conversations" data-empty={empty || undefined} aria-busy={active && loading}>
    {sections.map(({ id, date, entries }) => {
      const label = date === undefined ? t(`agentPanel.${id}`) : new Date(date).toLocaleDateString(language, { month: 'short', day: 'numeric', weekday: 'short' });
      return entries.length > 0 && <section className="agent-task-section" key={id} aria-label={label}>
        <h3 className="agent-task-section-heading" data-attention={id === "attention" || undefined}>
          {label}<span className="agent-section-count">{entries.length}</span>
        </h3>
        <div className="agent-task-section-rows">{entries.map((session, index) => <ConversationRow key={session.id} agent={agent}
          session={session} live={live.has(session.id)} now={now} index={index} />)}</div>
      </section>;
    })}
    {initialLoading && showLoading && <Loading />}
    {error && <Notice action={<Button onClick={() => setRetry(value => value + 1)}>{t("retry")}</Button>}>{error}</Notice>}
    {empty && <Empty icon={MessagesSquare}>{t("agentPanel.noConversations")}</Empty>}
    {next && <div ref={marker} className="agent-conversation-more" aria-hidden="true" />}
  </div>;
}
