import { useLayerNaturalContent } from './ui/LayerPortals';
import { PanelHeader, PanelFooter, usePanelState } from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import { useAppNow } from "../state/appEnvironment";
import { pendingSessions } from "../state/taskInteractions";
import { useTaskPresence } from "../state/requestRouting";
import { observeTaskPanel } from "../state/taskPanel";
import { useTaskQueue } from "../state/taskQueue";
import { TaskCard, ReviewUnavailable, TaskBackButton } from "./ui/TaskPresentation";
import TaskQueuedMessages from "./TaskQueuedMessages";
import { useTaskReview } from "../state/taskReview";
import { taskErrorText } from "../state/taskErrors";
import "./TaskDetail.css";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowUpRight, ArrowLeft, ArrowDown, ClipboardCheck, Maximize2, Minimize2, MoreHorizontal } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import type { AgentTimeline } from "../types";
import { activityApprovals, agentActivity, openActivitySession } from "../state/activity";
import { followsTimeline, refreshTimeline, reuseTimelineEntries, timelineScrollTarget } from "../state/timelineModel";
import { Button, Icon, IconButton, LoadingIndicator, Menu } from "./ui";
import TimelineEntries, { durationText, TimelinePlanDock } from "./TimelineEntries";
import { PhaseLabel } from "./activity";
import { TaskSpecChoice } from "./AgentDispatchDefaults";
import { isTaskId, taskState } from "../state/taskProjection";
import { acceptTaskExecution } from "../state/taskExecution";
import { executionStatus, executionSnapshot, executionPhase, terminalState } from "../state/taskExecutionModel";
import { timelineDuration, timelineGroups, turnDuration } from "../state/timelineGroups";
import RelayRoute from "./RelayRoute";
import TaskNeedsYou from "./TaskNeedsYou";
import TaskOwnership from "./TaskOwnership";
import { activityHeadline, type TrackedActivity } from "../state/activityModel";
import { trackedActivity } from "../state/activityBubbles";
import { selectAgentPanel } from "../state/overviewPanels";
import { TaskRelation, TaskParentLink } from "./ui/TaskRelation";
import type { TaskRuntime } from "../state/tasks";

import { name, orderedAgents } from "../state/agents";

export default function ActivityTimeline({ agent, session, expanded, onToggleWidth, onBack, backLabel, titleId, resizable = true }: {
  agent: string; session: TrackedActivity; expanded: boolean; onToggleWidth: () => void; onBack: () => void; titleId?: string; backLabel?: string; resizable?: boolean;
}) {
  const { snapshot } = agentActivity.use();
  const tracked = trackedActivity.use();
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
  const validId = isTaskId(session.id);
  const loading = validId && session.timeline && !timeline && !error;
  const viewport = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null);
  const requestEarlier = useRef<(() => void) | undefined>(undefined);
  const prependAnchor = useRef<{ height: number; top: number } | undefined>(undefined);
  const following = useRef(true), initial = useRef(true), previousRunning = useRef(true), previousTop = useRef(0);
  const manualDisclosure = useRef(false);
  const live = snapshot?.agents[agent]?.sessions.find(s => s.id === session.id && (!session.selectedTurnId || s.turnId === session.selectedTurnId));
  const trackedSession = tracked[agent]?.find(row => row.id === session.id || row.nativeSessionId === session.id);
  const relationKind = live?.relationKind ?? session.relationKind ?? trackedSession?.relationKind;
  const parentId = live?.parentSessionId ?? session.parentSessionId ?? trackedSession?.parentSessionId;
  const parent = parentId ? tracked[agent]?.find(row => row.id === parentId || row.nativeSessionId === parentId) : undefined;
  const [parentTitle, setParentTitle] = useState("");
  useEffect(() => {
    setParentTitle("");
    if (!parentId || parent?.title) return;
    let stopped = false;
    void api<TaskRuntime>(`tasks/runtime/${encodeURIComponent(parentId)}`).then(task => {
      if (!stopped) setParentTitle(task.title?.trim() ?? "");
    }).catch(() => {});
    return () => { stopped = true; };
  }, [parentId, parent?.title]);
  const external = session.source === "transcript";
  useTaskPresence(agent, session.id, !external && !readOnlyBrowser);
  // Only current activity establishes execution; persisted running/idle is not a result.
  const running = validId && !!live;

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
    if (agent !== "codex" || !validId) return;
    let stopped = false;
    void api<TaskRuntime>(`tasks/runtime/${encodeURIComponent(session.id)}`).then(task => {
      if (!stopped) setTaskTitle({ id: session.id, title: task.title?.trim() ?? "" });
    }).catch(() => { /* Use a neutral label when native thread metadata is unavailable. */ });
    return () => { stopped = true; };
  }, [agent, session.id, validId]);
  useEffect(() => {
    if (!validId || !session.timeline) return;
    let stopped = false, timer: ReturnType<typeof setTimeout>, current: AgentTimeline | undefined;
    let first = true, reading = false, fullRequested = false;
    requestEarlier.current = () => {
      if (!current?.preview || fullRequested) return;
      fullRequested = true;
      clearTimeout(timer);
      void read();
    };
    async function read() {
      if (reading || stopped) return;
      reading = true;
      const preview = !fullRequested && (first || current?.preview) && agent === "codex" && !external && !session.selectedTurnId;
      first = false;
      try {
        const read = (after?: number, recent = false) => session.conversation
          ? api<AgentTimeline>("agents/conversations/timeline", "POST", { agent, id: session.id, ...(after === undefined ? {} : { after }), ...(recent ? { recent } : {}) })
          : api<AgentTimeline>(`agents/timeline/${encodeURIComponent(session.id)}${recent ? "?recent=1" : after === undefined ? "" : `?after=${after}`}`);
        const next = preview
          ? await read(undefined, true)
          : external || current?.readOnly || current?.preview ? reuseTimelineEntries(current, await read()) : await refreshTimeline(current, read);
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
        if (current?.preview && !next.preview && !following.current && viewport.current) {
          prependAnchor.current = { height: viewport.current.scrollHeight, top: viewport.current.scrollTop };
        }
        current = next; setTimeline(next);
        if (!next.preview) acceptTaskExecution(agent, session.id, next);
        setError("");
      } catch (error) { if (!stopped) setError(String(error)); }
      finally {
        reading = false;
        if (!stopped) {
          const delay = fullRequested && current?.preview ? (preview ? 0 : 1000)
            : current?.preview || current?.readOnly || external ? 5000 : 1000;
          timer = setTimeout(read, delay);
        }
      }
    }
    void read();
    return () => { stopped = true; clearTimeout(timer); requestEarlier.current = undefined; };
  }, [agent, session.id, session.timeline, session.conversation, session.selectedTurnId, external, validId]);
  useLayoutEffect(() => {
    const node = viewport.current;
    if (!node || !timeline) return;
    const anchor = prependAnchor.current;
    if (anchor) {
      prependAnchor.current = undefined;
      node.scrollTop = anchor.top + Math.max(0, node.scrollHeight - anchor.height);
      previousTop.current = node.scrollTop;
    }
    if (timeline.preview && (running || node.scrollHeight <= node.clientHeight)) requestEarlier.current?.();
    if (manualDisclosure.current) return;
    const target = timelineScrollTarget(following.current, running || previousRunning.current, initial.current, node.scrollHeight);
    if (target !== undefined) { node.scrollTop = target; previousTop.current = node.scrollTop; }
    if (target !== undefined) setAtLatest(true);
    initial.current = false; previousRunning.current = running;
  }, [timeline, running]);
  const groups = timelineGroups(timeline?.entries ?? []);
  const historyTurn = session.selectedTurnId || groups.at(-1)?.turnId || session.turnId;
  const nativeSession = live ?? { ...session, turnId: historyTurn, interaction: undefined,
    dispatchSummary: historyTurn === session.turnId ? session.dispatchSummary : undefined };
  const agentName = name(orderedAgents().find(a => a.agent === agent) ?? { agent });
  const selectedEntries = session.selectedTurnId ? groups.find(group => group.turnId === session.selectedTurnId)?.entries : undefined;
  const duration = session.selectedTurnId ? turnDuration(selectedEntries ?? [], now, running, nativeSession.turnStartedAt, timeline?.turnTimings?.[session.selectedTurnId])
    : timelineDuration(timeline?.entries ?? [], now, running, nativeSession.turnId, timeline?.turnTimings, nativeSession.turnStartedAt);
  const project = timeline?.projectName || nativeSession.projectName || session.projectName
    || session.project?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const latestSummary = live ? live.dispatchSummary : (historyTurn && timeline?.turnDispatchSummaries?.[historyTurn]) || (!session.selectedTurnId ? timeline?.dispatchSummary : undefined) || nativeSession.dispatchSummary;
  const source = latestSummary?.controlSource;
  const plan = running ? [...(groups.at(-1)?.entries ?? [])].reverse().find(entry => entry.type === "plan" && entry.plan?.length) : undefined;
  const hasPending = !external && !timeline?.readOnly && running && pendingSessions(agent, nativeSession, timeline?.entries ?? [], submissions).length > 0;
  const state = taskState(timeline ? executionStatus(executionSnapshot(timeline), nativeSession.turnId) : session.status ?? undefined, running, hasPending);
  const detailPhase = relationKind && state === "running" ? executionPhase(nativeSession.phase, state) : undefined;
  const turnId = nativeSession.turnId || groups.at(-1)?.turnId;
  const { review, reviewError, reloadReview } = useTaskReview(session.id, turnId, terminalState(state));
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
      while (["reserved", "executing"].includes(receipt.state)) {
        await new Promise(resolve => setTimeout(resolve, 500));
        receipt = await api("tasks/control", "POST", { op: "receipt", args: { requestId: receipt.requestId } });
      }
      if (receipt.state !== "completed") throw new Error(receipt.error?.message || receipt.state);
    })().catch(error => setOpenError(String(error))).finally(() => { continuationBusy.current = false; setContinuing(false); });
  };
  // Preserve native conversation identity without borrowing another turn's configuration.
  const title = (validId && agent === "codex" && taskTitle?.id === session.id && taskTitle.title) || (agent !== "codex" && (nativeSession.title
    || timeline?.entries.find(entry => entry.type === "user")?.text?.trim().split("\n")[0])) || t("timeline.title");
  usePanelState({ busy: continuing });
  useLayerNaturalContent(content, true, { version: `${loading ? 'loading' : 'ready'}:${title}`, flexibleFooter: true, resetHeight: true });
  return <section ref={detail} className="agent-panel-layer task-detail-layer" data-related={!!relationKind || undefined} data-narrow={narrow || undefined}>
    <PanelHeader><header className="dialog-header task-detail-header">
      <div className="task-detail-navigation"><TaskBackButton aria-label={t("back")} title={backLabel ?? `${agentName}${project ? ` · ${project}` : ""}`} onClick={onBack}><Icon icon={ArrowLeft} /><RelayRoute source={source} agent={agent} label={project} /></TaskBackButton>
        {!narrow && <div className="actions">{!readOnlyBrowser && validId && nativeSession.open && <IconButton icon={ArrowUpRight} label={t("activity.open")} onClick={() => { setOpenError(""); void openActivitySession(agent, nativeSession).catch(error => setOpenError(String(error))); }} />}
          {resizable && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")} aria-pressed={expanded} onClick={onToggleWidth} />}</div>}
        {narrow && (!readOnlyBrowser && validId && nativeSession.open || resizable) && <div className="task-narrow-menu"><Menu label={t("detail.taskActions")} trigger={<IconButton icon={MoreHorizontal} label={t("detail.taskActions")} />} items={[
          ...(!readOnlyBrowser && validId && nativeSession.open ? [{ label: t("activity.open"), action: () => { setOpenError(""); void openActivitySession(agent, nativeSession).catch(error => setOpenError(String(error))); } }] : []),
          ...(resizable ? [{ label: t(expanded ? "restorePanelWidth" : "expandPanelWidth"), action: onToggleWidth }] : []),
        ]} /></div>}
      </div>
      <h2 id={titleId} className="activity-panel-title">{title}</h2>
      <div className="task-detail-chips"><TaskRelation kind={relationKind} />{detailPhase
        ? <PhaseLabel phase={detailPhase} running>{t(`activity.phase.${detailPhase}`)}</PhaseLabel>
        : <span className="task-state" role="status" data-state={state}>{t(`detail.state.${state}`)}</span>}
        {session.selectedTurnId && groups.some(group => group.turnId === session.selectedTurnId) && <span className="activity-meta-chip">{t("detail.selectedTurn", { count: groups.findIndex(group => group.turnId === session.selectedTurnId) + 1 })}</span>}
        <TaskSpecChoice agent={agent} threadId={session.id} taskId={session.source === "arc-task" ? session.id : undefined} summary={latestSummary}
          editable={!readOnlyBrowser && agent === "codex" && validId && !timeline?.readOnly} />
        <TaskOwnership ownership={timeline?.ownership} />
        {duration !== undefined && <time className="timeline-meta task-duration">{durationText(duration)}</time>}
      </div>
      {parentId && <TaskParentLink title={parent?.title || parentTitle || parentId} onClick={() => selectAgentPanel({ type: "task", agent,
        session: parent ?? { id: parentId, nativeSessionId: parentId, source: "codex-thread", title: parentTitle || undefined,
          phase: "idle", phaseSince: null, headline: "", timeline: true, orderAt: 0, observed: false } })} />}
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
    </header></PanelHeader>
    <div className="task-timeline" aria-busy={loading}>
      <div className="timeline-scroll" ref={viewport} tabIndex={0} aria-label={t("timeline.title")}
        onWheel={event => {
          const node = event.currentTarget;
          if (manualDisclosure.current) following.current = node.scrollHeight - node.scrollTop - node.clientHeight <= 24;
          manualDisclosure.current = false;
          userScroll.current = true;
          if (event.deltaY < 0) {
            following.current = false;
            if (node.scrollTop <= 32) requestEarlier.current?.();
          }
        }}
        onPointerDown={event => { if (event.target === event.currentTarget) userScroll.current = true; }}
        onTouchMove={() => { userScroll.current = true; }}
        onKeyDown={event => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) userScroll.current = true;
          if (timeline?.preview && (event.key === "Home" || (["ArrowUp", "PageUp"].includes(event.key) && event.currentTarget.scrollTop <= 32))) {
            following.current = false;
            requestEarlier.current?.();
          }
        }}
        onScroll={event => {
          if (!userScroll.current) return;
          const node = event.currentTarget;
          if (node.scrollTop <= 32 && node.scrollTop < previousTop.current) requestEarlier.current?.();
          following.current = followsTimeline(node.scrollTop, node.clientHeight, node.scrollHeight, previousTop.current);
          if (!following.current) manualDisclosure.current = false;
          previousTop.current = node.scrollTop;
          setAtLatest(node.scrollHeight - node.scrollTop - node.clientHeight <= 24);
        }}>
        <div ref={content} className={loading ? "timeline-loading" : "timeline-entries"} onClickCapture={event => {
          if ((event.target as Element).closest("button, [data-turn-collapsed]")) manualDisclosure.current = true;
        }}>
          {loading ? <LoadingIndicator label={t("timeline.loading")} /> : <>
          {(!validId || error || openError) && <p className="timeline-error" role="alert">{!validId ? t("detail.taskUnavailable") : taskErrorText(openError || error)}</p>}
          {timeline?.coverage.state === "partial" && !timeline.preview && !timeline.coverage.truncated && <p className="timeline-meta">{t("timeline.partial")}</p>}
          {!session.timeline && <section className="activity-session-summary">
            {executionPhase(nativeSession.phase, state) && <span className="timeline-meta">{t(`activity.phase.${nativeSession.phase}`)}</span>}
            {(nativeSession.recentContent?.length ? nativeSession.recentContent : [activityHeadline(nativeSession, t("timeline.title")).text])
              .map((text, index) => <p key={index}>{text}</p>)}
          </section>}
          {timeline?.entries.length === 0 && <p className="timeline-meta">{t("timeline.empty")}</p>}
          <TimelineEntries narrow={narrow} key={session.id} entries={timeline?.entries ?? []} agent={agent} session={nativeSession} now={now} running={running} turnTimings={timeline?.turnTimings} status={timeline?.status} turnStatuses={timeline?.turnStatuses} turnDispatchSummaries={timeline?.turnDispatchSummaries}
            onResume={!readOnlyBrowser && agent === "codex" && !external && !timeline?.readOnly && state === "interrupted" && turnId ? () => continueTurn("resume") : undefined}
            onRetry={!readOnlyBrowser && !external && !timeline?.readOnly && state === "failed" && turnId ? () => continueTurn("retry") : undefined} continuing={continuing} />
          {hasPending && !groups.some(group => !nativeSession.turnId || !group.turnId || group.turnId === nativeSession.turnId) && <TaskNeedsYou agent={agent} session={nativeSession} entries={timeline?.entries ?? []} source={source} narrow={narrow} inline />}
          <TaskQueuedMessages queue={queue} agent={agent} />
          {terminalState(state) && review && <TaskCard reply className="task-final task-review-info" data-verdict={review.verdict}>
            <header><Icon icon={ClipboardCheck} /><strong>{t("detail.reviewInfo")}</strong></header>
            <div className="timeline-meta"><span>{t(review.verdict === "pass" ? "detail.reviewPassed" : "detail.reviewRework")}</span>
              {review.reviewer?.controlSource && <span>{review.reviewer.controlSource}</span>}
              <time dateTime={review.reviewedAt}>{new Date(review.reviewedAt).toLocaleString()}</time>
            </div>
            {review.note && <p>{review.note}</p>}
          </TaskCard>}
          {terminalState(state) && reviewError && <ReviewUnavailable action={<Button variant="ghost" onClick={reloadReview}>{t("retry")}</Button>}>{t("detail.reviewUnavailable")}</ReviewUnavailable>}

          </>}
        </div>
      </div>
      {!atLatest && <IconButton className="timeline-latest" variant="secondary" icon={ArrowDown} size={20} label={t("timeline.latest")} onClick={latest} />}
    </div>
    {plan && <PanelFooter><TimelinePlanDock key={groups.at(-1)?.id} entry={plan} /></PanelFooter>}
  </section>;
}
