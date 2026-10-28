import { refreshTaskExecution, taskExecution, taskExecutions } from "../state/taskExecution";
import { executionStatus, terminalState } from "../state/taskExecutionModel";
import { taskState } from "../state/taskProjection";
import { pendingSessions } from "../state/taskInteractions";
import { activityApprovals } from "../state/activity";
import { useAppNow } from "../state/appEnvironment";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, MessagesSquare } from "lucide-react";
import { locale, t } from "../i18n";
import { tasks } from "../state/tasks";
import { trackedActivity } from "../state/activityBubbles";
import { activitySections } from "../state/activitySections";
import { agentActivity } from "../state/activity";
import { selectAgentPanel } from "../state/overviewPanels";
import { navigation } from "../state/navigation";
import { sourceDispatches, dispatchState, dispatchTaskId } from "../state/sourceDispatch";
import { PhaseTile } from "./activity";
import { Empty, Icon, Notice } from "./ui";

export default function SourceDispatches({ sourceId }: { sourceId: string }) {
  const now = useAppNow(60_000), language = locale.use();
  const tracked = trackedActivity.use();
  const { records, error } = tasks.use(), { snapshot } = agentActivity.use();
  taskExecutions.use();
  const submissions = activityApprovals.use();
  const [visible, setVisible] = useState(8);
  const more = useRef<HTMLDivElement>(null);
  const liveOf = (record: typeof records[number]) => snapshot?.agents[record.agent ?? "codex"]?.sessions.find(session => session.id === dispatchTaskId(record) && !!record.turnId && session.turnId === record.turnId);
  const stateOf = (record: typeof records[number]) => {
    const agent = record.agent ?? "codex", id = dispatchTaskId(record), execution = id ? taskExecution(agent, id) : undefined, live = liveOf(record);
    return dispatchState(record, execution, live, live ? pendingSessions(agent, live, execution?.interactions ?? [], submissions).length > 0 : false);
  };
  const unreadOf = (record: typeof records[number]) => tracked[record.agent ?? "codex"]?.find(session => session.id === dispatchTaskId(record)
    && session.endedAt !== undefined && session.readAt === undefined && !!record.turnId && session.turnId === record.turnId);
  const dispatches = sourceDispatches(records, sourceId);
  const sections = activitySections(dispatches, now, record => Date.parse(record.createdAt) || 0, record => {
    const state = stateOf(record);
    return state === 'needsYou' || state === 'awaitingApproval' ? 'attention' : state === 'running' ? 'running' : unreadOf(record) ? 'unread' : undefined;
  });
  const rows = sections.flatMap(section => section.entries).slice(0, visible);
  const visibleIds = new Set(rows.map(record => record.requestId));
  useEffect(() => { setVisible(8); }, [sourceId]);
  useEffect(() => {
    const marker = more.current;
    if (!marker || visible >= dispatches.length) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) setVisible(count => count + 8);
    }, { root: marker.closest(".agent-view-scroll, .workspace"), rootMargin: "0px 0px 120px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [visible, dispatches.length]);
  const identities = rows.map(record => [record.agent ?? "codex", dispatchTaskId(record), record.turnId] as const).filter((row): row is readonly [string, string, string | undefined] => !!row[1]);
  const identityKey = JSON.stringify(identities);
  useEffect(() => {
    let stopped = false, reading = false;
    const read = async () => {
      if (reading || document.hidden) return;
      reading = true;
      const missing = [...new Map(identities.filter(([agent, id, turn]) => turn && !terminalState(taskState(executionStatus(taskExecution(agent, id), turn), false)))
        .map(([agent, id]) => [JSON.stringify([agent, id]), [agent, id] as const])).values()];
      for (let i = 0; i < missing.length && !stopped; i += 4) await Promise.all(missing.slice(i, i + 4).map(([agent, id]) => refreshTaskExecution(agent, id).catch(() => {})));
      reading = false;
    };
    void read(); const timer = setInterval(() => void read(), 10000);
    return () => { stopped = true; clearInterval(timer); };
  }, [identityKey]);
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
          const id = dispatchTaskId(record), agent = record.agent ?? "codex", unread = unreadOf(record), live = liveOf(record);
          const state = stateOf(record);
          const title = record.task.title || live?.title || record.runtime?.title || record.task.prompt.split("\n")[0] || t("taskRequest");
          const phase = state === "needsYou" || state === "awaitingApproval" ? "interaction" : state === "running" ? live?.phase ?? "idle" : "idle";
          const canOpen = !!id && !!record.turnId;
          const label = ["awaitingApproval", "submitting", "notExecuted", "submissionUnknown", "submissionFailed"].includes(state) ? t(`sourcePanel.${state}`) : t(`detail.state.${state}`);
          return <button key={record.requestId} className="source-dispatch-row" disabled={!canOpen} data-state={state} onClick={() => {
            if (!id || !canOpen) return;
            selectAgentPanel({ type: "task", agent, session: { ...(live ? { ...live, orderAt: Date.parse(record.createdAt) } : unread ? { ...unread, orderAt: Date.parse(record.createdAt) } : {
              id, turnId: record.turnId, source: agent === "codex" ? "codex-thread" : "arc-task", observed: false, conversation: true, title, phase, headline: title, phaseSince: null, timeline: true,
              project: record.task.project || record.task.directory, startedAt: record.createdAt, orderAt: Date.parse(record.createdAt),
            }), selectedTurnId: record.turnId } });
            navigation.set(old => ({ ...old, page: "overview" }));
          }}>
            <PhaseTile phase={phase} running={state === "running"} completed={state === "done"} paused={state === "interrupted"} outcome={state === "failed" || state === "submissionFailed" ? "failed" : state === "unknown" || state === "submissionUnknown" ? "unknown" : undefined} />
            <span><strong>{title}</strong><span className="source-dispatch-meta">{record.agent ?? "Codex"} · <span>{label}</span></span></span>
            {canOpen && <Icon icon={ChevronRight} />}
          </button>;
        })}</div>
      </section>;
    })}
    {empty && <Empty icon={MessagesSquare}>{t("sourcePanel.noRecords")}</Empty>}
    {visible < dispatches.length && <div ref={more} className="source-dispatch-more" aria-hidden="true" />}
  </div>;
}
