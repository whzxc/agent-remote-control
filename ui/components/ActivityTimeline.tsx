import { useAppNow } from "../state/appEnvironment";
import { pendingSessions } from "../state/taskInteractions";
import { useTaskPresence } from "../state/requestRouting";
import { observeTaskPanel } from "../state/taskPanel";
import { useTaskQueue } from "../state/taskQueue";
import TaskQueuedMessages from "./TaskQueuedMessages";
import { useTaskReview } from "../state/taskReview";
import { taskErrorText } from "../state/taskErrors";
import "./TaskDetail.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowLeft, ArrowDown, Maximize2, Minimize2, MoreHorizontal, Zap } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import type { AgentTimeline } from "../types";
import { activityApprovals, agentActivity, openActivitySession } from "../state/activity";
import { followsTimeline, refreshTimeline, timelineScrollTarget } from "../state/timelineModel";
import { Button, Icon, IconButton, LoadingIndicator, Menu } from "./ui";
import TimelineEntries, { durationText } from "./TimelineEntries";
import { dispatchSourceLabel, SourceBadge } from "./activity";
import { taskState } from "../state/taskProjection";
import { timelineDuration, timelineGroups } from "../state/timelineGroups";
import TaskNeedsYou from "./TaskNeedsYou";
import TaskOwnership from "./TaskOwnership";
import { activityHeadline, type TrackedActivity } from "../state/activityModel";
import type { TaskRuntime } from "../state/tasks";
import { useDispatchCatalog } from "../state/dispatchCatalog";
import { dispatchSpecParts } from "./composites/dispatchSpecLabel";

import { name, orderedAgents } from "../state/agents";

export default function ActivityTimeline({ agent, session, expanded, onToggleWidth, onBack, titleId, resizable = true }: {
  agent: string; session: TrackedActivity; expanded: boolean; onToggleWidth: () => void; onBack: () => void; titleId?: string; resizable?: boolean;
}) {
  const { snapshot } = agentActivity.use();
  const detail = useRef<HTMLElement>(null);
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    const node = detail.current;
    if (!node) return;
    const measure = () => { if (node.clientWidth > 0) setNarrow(node.clientWidth <= 360); };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const submissions = activityApprovals.use();
  const [atLatest, setAtLatest] = useState(true);
  const [timeline, setTimeline] = useState<AgentTimeline>();
  const [taskTitle, setTaskTitle] = useState<{ id: string; title: string }>();
  const [continuing, setContinuing] = useState(false);
  const continuationBusy = useRef(false);
  const continuationRequest = useRef<{ turnId: string; action: "resume" | "retry"; op: string; args: Record<string, unknown> } | undefined>(undefined);
  const [error, setError] = useState(""), [openError, setOpenError] = useState("");
  const loading = session.timeline && !timeline && !error;
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const following = useRef(true), initial = useRef(true), previousRunning = useRef(true), previousTop = useRef(0);
  const manualDisclosure = useRef(false);
  const live = snapshot?.agents[agent]?.sessions.find(s => s.id === session.id);
  const external = session.source === "transcript";
  useTaskPresence(agent, session.id, !external);
  // Completed history entries do not override a session in the live snapshot.
  const running = !!live || session.endedAt === undefined && !external && !timeline?.readOnly && ["running", "inProgress", "starting", "waiting-permission", "cancelling"].includes(timeline?.status ?? "");

  const now = useAppNow(running ? 1000 : null);
  const userScroll = useRef(false);
  useEffect(() => {
    const node = viewport.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.cancelable || event.defaultPrevented || event.ctrlKey || !(event.target instanceof Element)) return;
      const nested = event.target.closest<HTMLElement>("pre, .timeline-table, .timeline-files");
      if (!nested || !node.contains(nested)) return;
      const line = Number.parseFloat(getComputedStyle(nested).lineHeight) || 16;
      const dx = event.deltaX * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? nested.clientWidth : 1);
      const dy = event.deltaY * (event.deltaMode === 1 ? line : event.deltaMode === 2 ? node.clientHeight : 1);
      const left = Math.max(0, Math.min(nested.scrollWidth - nested.clientWidth, nested.scrollLeft + dx));
      const top = Math.max(0, Math.min(node.scrollHeight - node.clientHeight, node.scrollTop + dy));
      if (left === nested.scrollLeft && top === node.scrollTop) return;
      // Deliver each axis to its owner before cancelling the browser's combined default scroll.
      // Leave unconsumed boundary events alone so they can chain normally.
      nested.scrollLeft = left;
      node.scrollTop = top;
      event.preventDefault();
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, []);
  useEffect(() => {
    if (agent !== "codex") return;
    let stopped = false;
    void api<TaskRuntime>(`tasks/runtime/${encodeURIComponent(session.id)}`).then(task => {
      if (!stopped) setTaskTitle({ id: session.id, title: task.title?.trim() ?? "" });
    }).catch(() => { /* Use a neutral label when native thread metadata is unavailable. */ });
    return () => { stopped = true; };
  }, [agent, session.id]);
  useEffect(() => {
    if (!session.timeline) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, current: AgentTimeline | undefined;
    async function read() {
      try {
        const read = (after?: number) => session.conversation
          ? api<AgentTimeline>("agents/conversations/timeline", "POST", { agent, id: session.id, ...(after === undefined ? {} : { after }) })
          : api<AgentTimeline>(`agents/timeline/${encodeURIComponent(session.id)}${after === undefined ? "" : `?after=${after}`}`);
        const next = external || current?.readOnly ? await read() : await refreshTimeline(current, read);
        if (stopped) return;
        if (manualDisclosure.current && (next.cursor !== current?.cursor || next.status !== current?.status
          || JSON.stringify(next.entries) !== JSON.stringify(current?.entries))) {
          // Resume only for new timeline content, using the position before it renders.
          const node = viewport.current;
          if (node) {
            following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
            setAtLatest(following.current);
          }
          manualDisclosure.current = false;
        }
        current = next; setTimeline(next); setError("");
      } catch (error) { if (!stopped) setError(String(error)); }
      if (!stopped) timer = setTimeout(read, external || current?.readOnly ? 5000 : 1000);
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); };
  }, [agent, session.id, session.timeline, session.conversation, external]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !timeline || manualDisclosure.current) return;
    const target = timelineScrollTarget(following.current, running || previousRunning.current, initial.current, node.scrollHeight);
    if (target !== undefined) { node.scrollTop = target; previousTop.current = node.scrollTop; }
    if (target !== undefined) setAtLatest(true);
    initial.current = false; previousRunning.current = running;
  }, [timeline, running]);
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      const node = viewport.current;
      // Disclosure resizing is local navigation, including its animation frames.
      if (node && !manualDisclosure.current && following.current) { node.scrollTop = node.scrollHeight; previousTop.current = node.scrollTop; }
    });
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  const groups = timelineGroups(timeline?.entries ?? []);
  const historyTurn = groups.at(-1)?.turnId || session.turnId;
  const nativeSession = live ?? { ...session, turnId: historyTurn, interaction: undefined,
    dispatchSummary: historyTurn === session.turnId ? session.dispatchSummary : undefined };
  const agentName = name(orderedAgents().find(a => a.agent === agent) ?? { agent });
  const duration = timelineDuration(timeline?.entries ?? [], now, running, nativeSession.turnId, timeline?.turnTimings, nativeSession.turnStartedAt);
  const project = timeline?.projectName || nativeSession.projectName || session.projectName
    || session.project?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const latestSummary = live ? live.dispatchSummary : (historyTurn && timeline?.turnDispatchSummaries?.[historyTurn]) || timeline?.dispatchSummary || nativeSession.dispatchSummary;
  const catalog = useDispatchCatalog(agent, session.source === "arc-task" ? session.id : undefined, !!latestSummary?.model)?.catalog;
  const spec = dispatchSpecParts(latestSummary, catalog, t);
  const fast = latestSummary?.serviceTier === "priority" || latestSummary?.serviceTier === "fast";
  const source = latestSummary?.controlSource;
  const sourceLabel = source && dispatchSourceLabel(source);
  const hasPending = !external && !timeline?.readOnly && running && pendingSessions(agent, nativeSession, timeline?.entries ?? [], submissions).length > 0;
  const state = taskState(timeline?.status, running, hasPending);
  const turnId = nativeSession.turnId || groups.at(-1)?.turnId;
  const turnSource = timeline
    ? (turnId && timeline.turnDispatchSummaries?.[turnId]?.controlSource) || timeline.dispatchSummary?.controlSource
      || groups.find(group => group.turnId === turnId)?.entries.find(entry => entry.type === "user")?.controlSource
    : source;
  const fromControlSource = !!turnSource && turnSource.kind !== "ARC";
  const { review, reviewError } = useTaskReview(session.id, turnId, !external && !timeline?.readOnly && fromControlSource);
  const queue = useTaskQueue(external || timeline?.readOnly ? "" : agent, session.id);
  const latest = () => {
    const node = viewport.current;
    if (!node) return;
    manualDisclosure.current = false; following.current = true; userScroll.current = false;
    node.scrollTop = node.scrollHeight; previousTop.current = node.scrollTop;
    setAtLatest(true); node.focus({ preventScroll: true });
  };
  const disclosureIds = useRef(new WeakMap<Element, string>());
  useEffect(() => observeTaskPanel({ agent, id: session.id,
    read: () => {
      const disclosures = [...(detail.current?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ?? [])].map(button => {
        let id = disclosureIds.current.get(button);
        if (!id) { id = crypto.randomUUID(); disclosureIds.current.set(button, id); }
        return { id, label: button.getAttribute("aria-label") || button.textContent, expanded: button.getAttribute("aria-expanded") === "true", disabled: button.disabled };
      });
      return { agent, id: session.id, width: detail.current?.closest('[role="dialog"]')?.getBoundingClientRect().width ?? null, following: following.current, atLatest, expanded, state, turnId, timeline, queue: queue.items, review, disclosures };
    },
    act: request => {
      if (request.action === "latest") latest();
      else if (request.action === "follow") {
        if (typeof request.following !== "boolean") throw new Error("FOLLOW_REQUIRED: supply following:true or false");
        if (request.following) latest(); else following.current = false;
      } else if (request.action === "width") {
        if (!resizable) throw new Error("PANEL_WIDTH_FIXED: portrait panels use the available inner rail area; use app_env taskPanelWidth or switch to landscape");
        onToggleWidth();
      }
      else if (request.action === "back") onBack();
      else if (request.action === "disclose") {
        const button = [...(detail.current?.querySelectorAll<HTMLButtonElement>("button[aria-expanded]") ?? [])].find(node => disclosureIds.current.get(node) === request.target);
        if (!button || button.disabled) throw new Error("DISCLOSURE_CHANGED: read task_panel again");
        button.focus({ preventScroll: true }); button.click();
      }
    },
  }));
  const continueTurn = (action: "resume" | "retry") => {
    if (!turnId || continuationBusy.current) return;
    if (continuationRequest.current?.turnId !== turnId || continuationRequest.current.action !== action) {
      const requestId = crypto.randomUUID();
      const prompt = `Continue from failed turn ${turnId} in this task. Inspect the current results first, skip completed work, and do not repeat successful or uncertain side effects. If the failure is already resolved, report the current state.`;
      continuationRequest.current = { turnId, action,
        op: action === "resume" ? "codex_resume" : agent === "codex" ? "codex_send" : "agent_send",
        args: action === "resume" ? { threadId: session.id, turnId, requestId } : agent === "codex"
          ? { threadId: session.id, prompt, requestId, sendMode: "next", approval: "approved",
            ...(latestSummary?.model ? { model: latestSummary.model } : {}), ...(latestSummary?.effort ? { effort: latestSummary.effort } : {}),
            ...(latestSummary?.serviceTier ? { serviceTier: latestSummary.serviceTier } : {}) }
          : { agent, taskId: session.id, prompt, requestId, approval: "approved" } };
    }
    const request = continuationRequest.current;
    continuationBusy.current = true; setContinuing(true); setOpenError("");
    void (async () => {
      let receipt = await api<{ state: string; requestId: string; error?: { message?: string } }>("tasks/control", "POST", { op: request.op, args: request.args });
      while (["pending", "reserved", "submitting"].includes(receipt.state)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        receipt = await api("tasks/control", "POST", { op: "receipt", args: { requestId: receipt.requestId } });
      }
      if (receipt.state !== "completed") throw new Error(receipt.error?.message || receipt.state);
    })().catch(error => setOpenError(String(error))).finally(() => { continuationBusy.current = false; setContinuing(false); });
  };
  // Preserve native conversation identity without borrowing another turn's configuration.
  const title = (agent === "codex" && taskTitle?.id === session.id && taskTitle.title) || (agent !== "codex" && (nativeSession.title
    || timeline?.entries.find(entry => entry.type === "user")?.text?.trim().split("\n")[0])) || t("timeline.title");
  return <section ref={detail} className="agent-panel-layer task-detail-layer" data-narrow={narrow || undefined}>
    <header className="dialog-header task-detail-header">
      <div className="task-detail-navigation"><Button variant="ghost" aria-label={t("back")} title={`${agentName}${project ? ` · ${project}` : ""}`} onClick={onBack}><Icon icon={ArrowLeft} /><span>{agentName}{project && ` · ${project}`}</span></Button>
        {!narrow && <div className="actions">{nativeSession.open && <IconButton icon={ArrowUpRight} label={t("activity.open")} onClick={() => { setOpenError(""); void openActivitySession(agent, nativeSession).catch(error => setOpenError(String(error))); }} />}
          {resizable && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")} aria-pressed={expanded} onClick={onToggleWidth} />}</div>}
        {narrow && (nativeSession.open || resizable) && <div className="task-narrow-menu"><Menu label={t("detail.taskActions")} trigger={<IconButton icon={MoreHorizontal} label={t("detail.taskActions")} />} items={[
          ...(nativeSession.open ? [{ label: t("activity.open"), action: () => { setOpenError(""); void openActivitySession(agent, nativeSession).catch(error => setOpenError(String(error))); } }] : []),
          ...(resizable ? [{ label: t(expanded ? "restorePanelWidth" : "expandPanelWidth"), action: onToggleWidth }] : []),
        ]} /></div>}
      </div>
      <h2 id={titleId} className="activity-panel-title">{title}</h2>
      <div className="task-detail-chips"><span className="task-state" data-state={state}>{t(`detail.state.${state}`)}</span>
        {spec.model && <span className="task-spec-chip" title={latestSummary?.model}>{spec.model}</span>}
        {spec.effort && <span className="task-spec-chip">{spec.effort}</span>}
        {spec.tier && <span className="task-spec-chip">{fast && <Icon icon={Zap} />}{spec.tier}</span>}
        {source && <span className="task-source-chip"><SourceBadge source={source} /><span>{t("detail.via", { source: sourceLabel })}</span></span>}
        <TaskOwnership ownership={timeline?.ownership} />
        {duration !== undefined && <time className="timeline-meta task-duration">{durationText(duration)}</time>}
      </div>
      {!!groups.length && <div className="task-turn-progress">{groups.map((group, index) => {
        const current = index === groups.length - 1 && (!nativeSession.turnId || nativeSession.turnId === group.turnId);
        const turnState = taskState((group.turnId && timeline?.turnStatuses?.[group.turnId]) || (current ? timeline?.status : undefined), current && running, current && hasPending);
        const plan = [...group.entries].reverse().find(entry => entry.type === "plan")?.plan;
        const completed = plan?.filter(step => step.status === "completed").length ?? 0;
        const value = plan?.length ? completed / plan.length * 100 : turnState === "done" ? 100 : undefined;
        return <div key={group.id} role="progressbar" aria-label={t("detail.turnProgress", { count: index + 1, state: t(`detail.state.${turnState}`) })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}
          aria-valuetext={plan?.length ? t("detail.planProgress", { completed, total: plan.length }) : t(`detail.state.${turnState}`)} data-state={turnState} data-indeterminate={value === undefined || undefined}>
          <span style={value === undefined ? undefined : { width: `${value}%` }} />
        </div>;
      })}</div>}
    </header>
    <div className="task-timeline" aria-busy={loading}>
      <div className="timeline-scroll" ref={viewport} tabIndex={0} aria-label={t("timeline.title")}
        onWheel={event => {
          const node = event.currentTarget;
          if (manualDisclosure.current) following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
          manualDisclosure.current = false;
          userScroll.current = true;
          if (event.deltaY < 0) following.current = false;
        }}
        onPointerDown={event => { if (event.target === event.currentTarget) userScroll.current = true; }}
        onTouchMove={() => { userScroll.current = true; }}
        onKeyDown={event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScroll.current = true; }}
        onScroll={event => {
          if (!userScroll.current) return;
          const node = event.currentTarget;
          following.current = followsTimeline(node.scrollTop, node.clientHeight, node.scrollHeight, previousTop.current);
          if (!following.current) manualDisclosure.current = false;
          previousTop.current = node.scrollTop;
          setAtLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
        }}>
        <div ref={content} className={loading ? "timeline-loading" : "timeline-entries"} onClickCapture={event => {
          if ((event.target as Element).closest("button, .timeline-turn[data-state=closed]")) manualDisclosure.current = true;
        }}>
          {loading ? <LoadingIndicator label={t("timeline.loading")} /> : <>
          {(error || openError || reviewError) && <p className="timeline-error" role="alert">{taskErrorText(openError || error || reviewError)}</p>}
          {timeline?.coverage.state === "partial" && !timeline.coverage.truncated && <p className="timeline-meta">{t("timeline.partial")}</p>}
          {!session.timeline && <section className="activity-session-summary">
            <span className="timeline-meta">{t(`activity.phase.${nativeSession.phase}`)}</span>
            {(nativeSession.recentContent?.length ? nativeSession.recentContent : [activityHeadline(nativeSession, t("timeline.title")).text])
              .map((text, index) => <p key={index}>{text}</p>)}
          </section>}
          {timeline?.entries.length === 0 && <p className="timeline-meta">{t("timeline.empty")}</p>}
          <TimelineEntries key={session.id} entries={timeline?.entries ?? []} agent={agent} session={nativeSession} now={now} running={running} turnTimings={timeline?.turnTimings} status={timeline?.status} turnStatuses={timeline?.turnStatuses} turnDispatchSummaries={timeline?.turnDispatchSummaries}
            onResume={agent === "codex" && !external && !timeline?.readOnly && state === "interrupted" && turnId ? () => continueTurn("resume") : undefined}
            onRetry={!external && !timeline?.readOnly && state === "failed" && turnId ? () => continueTurn("retry") : undefined} continuing={continuing} />
          <TaskQueuedMessages queue={queue} />
          </>}
        </div>
      </div>
      {!atLatest && <IconButton className="timeline-latest" variant="secondary" icon={ArrowDown} size={20} label={t("timeline.latest")} onClick={latest} />}
    </div>
    {hasPending && <TaskNeedsYou agent={agent} session={nativeSession} entries={timeline?.entries ?? []} source={sourceLabel} narrow={narrow} />}
  </section>;
}
