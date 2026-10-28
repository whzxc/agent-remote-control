import { updates } from "../state/updates";
import { updateBlocks } from "../state/updateModel";
import { useReducedMotion } from "../state/appEnvironment";
import { useRef, useState } from "react";
import { Check } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { locale, t } from "../i18n";
import { PhaseTile, PhaseLabel, StepTrail, SpecPill, SourceBadge } from "./activity";
import { selectAgentPanel } from "../state/overviewPanels";
import { activityHeadline, type TrackedActivity, type BubbleDensity } from "../state/activityModel";
import { useInterval } from "../state/hooks";
import FilePath from "./FilePath";
import { Button, Icon } from "./ui";
import { taskState } from "../state/taskProjection";

export function elapsed(since: string | null | undefined, now: number) {
  const seconds = since ? Math.max(0, Math.floor((now - Date.parse(since)) / 1000)) : NaN;
  if (!Number.isFinite(seconds)) return "—";
  const minutes = Math.floor(seconds / 60), remainder = String(seconds % 60).padStart(2, "0");
  return seconds < 3600 ? `${minutes}:${remainder}` : `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${remainder}`;
}
function Headline({ session }: { session: TrackedActivity }) {
  const reduced = useReducedMotion(), latest = useRef(session);
  latest.current = session;
  const [display, setDisplay] = useState(session);
  useInterval(() => setDisplay(latest.current), 1000);
  const headline = display.interaction ? { text: display.interaction.summary, path: undefined, fallback: false } : activityHeadline(display, t("timeline.title"));
  return <span className={`activity-headline ${!headline.fallback && (display.phase === "command" || !!headline.path) ? "mono" : ""} ${headline.fallback ? "activity-headline-fallback" : ""}`}>
    <AnimatePresence initial={false}>
      <motion.span key={`${display.phase}:${headline.text}`} initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduced ? 0 : -5 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        {headline.path ? <FilePath path={headline.path} project={display.project} /> : headline.text}
      </motion.span>
    </AnimatePresence>
  </span>;
}
export function ActivityBubbleContent({ agent, session, now, density = "standard", historical = false, conversationRow = false, showSourceBadge = true }: { agent?: string; session: TrackedActivity; now: number; density?: BubbleDensity; historical?: boolean; conversationRow?: boolean; showSourceBadge?: boolean }) {
  const language = locale.use();
  const paused = ["cancelled", "interrupted", "aborted"].includes(session.status ?? "");
  const historyState = historical ? taskState(session.status ?? undefined, false) : undefined;
  const outcome = historyState === "failed" || historyState === "unknown" ? historyState : undefined;
  const completed = !paused && !outcome && (session.endedAt !== undefined || historyState === "done");
  const running = !paused && !completed && !session.interaction && session.phase !== "idle";
  const unread = completed && !historical && session.readAt === undefined;
  const phase = session.interaction ? "interaction" : session.phase;
  const phaseLabel = outcome ? `detail.state.${outcome}` : completed ? "activity.completed" : session.interaction ? "activity.waitingConfirm" : `activity.phase.${phase}`;
  const source = session.dispatchSummary?.controlSource;
  const project = (session.projectName || session.project)?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const previous = session.recentContent?.filter(text => text !== activityHeadline(session).text).at(-1);
  const duration = elapsed(session.turnStartedAt, session.endedAt ?? now);
  const detail = session.interaction ? t("activity.pendingHint") : completed ? duration === "—" ? undefined : t("activity.totalDuration", { duration }) : previous;
  const created = Date.parse(session.startedAt ?? "");
  const conversation = conversationRow;
  const createdTime = Number.isFinite(created) && <time className="activity-created" dateTime={session.startedAt!}
    title={t("agentPanel.created", { time: new Date(created).toLocaleString(language) })}>
    {new Date(created).toLocaleDateString(language, { ...(new Date(created).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } as const : {}), month: "short", day: "numeric" })}
  </time>;
  return <>
    <PhaseTile phase={phase} running={running} completed={completed} paused={paused} outcome={outcome} source={showSourceBadge ? source : undefined} />
    {historical && <span className="sr-only">{t(outcome ? `detail.state.${outcome}` : paused ? "timeline.status.cancelled" : "activity.completed")}</span>}
    <span className="activity-copy">
      <span className="activity-title-row"><strong>{session.title || t("timeline.title")}</strong>
        {unread && <span className="activity-unread" role="img" aria-label={t("activity.unread")} />}
        {session.interaction ? <span className="activity-pending">{t("activity.pending")}</span> : !historical && <time>{elapsed(session.turnStartedAt, session.endedAt ?? now)}</time>}
      </span>
      {(!historical || !conversation) && <span className="activity-phase">
        {historical ? createdTime : <>
          <PhaseLabel phase={phase} running={running} completed={completed}>{t(phaseLabel)}</PhaseLabel>
          <Headline session={session.interaction ? { ...session, headline: session.interaction.summary } : session} />
        </>}
      </span>}
      {density === "detailed" && <span className="activity-detail-line" title={detail}>{detail || "\u00a0"}</span>}
      {density !== "compact" && <span className={`activity-spec-row ${conversation ? "activity-conversation-meta" : ""}`}>
        {conversation && project && <span className="activity-project" title={session.project!}>{project}</span>}
        <SpecPill agent={agent} taskId={session.source === "arc-task" ? session.id : undefined} summary={session.dispatchSummary} />
        {conversation && !!session.turnCount && <span className="activity-spec">{t("timeline.turnCount", { count: session.turnCount })}</span>}
        {!conversation && project && <span className="activity-project" title={session.project!}>{project}</span>}
        {conversation ? createdTime : <StepTrail steps={session.recentSteps} running={running} />}
      </span>}
    </span>
  </>;
}
export function ActivityBubble({ agent, session, now, onMove, onRead, density = "standard" }: { agent: string; session: TrackedActivity; now: number; density?: BubbleDensity; onMove?: (by: number) => void; onRead: () => void }) {
  const blocking = updateBlocks(updates.use().snapshot, agent, session.id);
  const completed = session.endedAt !== undefined, unread = completed && session.readAt === undefined;
  const press = useRef<{ id: number; x: number; y: number; moved: boolean } | undefined>(undefined);
  const cancelled = useRef(false);
  const move = (event: React.PointerEvent) => {
    const start = press.current;
    if (start?.id === event.pointerId && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) start.moved = true;
  };
  const hint = t("timeline.open");
  return <div className="activity-bubble-shell"><button type="button" className={`activity-bubble ${session.interaction ? "needs-attention" : ""} ${completed ? "completed" : ""}`}
      data-update-blocking={blocking || undefined}
      data-density={density}
      data-timeline-anchor
      data-unread={unread || undefined}
      aria-keyshortcuts={onMove ? "ArrowUp ArrowDown" : undefined} aria-description={onMove ? t("reorderNodeHint") : undefined}
      onKeyDown={event => { if (onMove && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventDefault(); onMove(event.key === "ArrowUp" ? -1 : 1);
      } }}
      data-activity-session={JSON.stringify([agent, session.id])}
      aria-label={`${session.title || t("timeline.title")}${unread ? ` · ${t("activity.unread")}` : ""} · ${hint}`} onClick={() => {
        selectAgentPanel({ type: "task", agent, session });
      }}>
      <ActivityBubbleContent agent={agent} session={session} now={now} density={density} showSourceBadge={!unread} />
      {blocking && <span className="update-blocking-tag">{t("updates.waitingReply")}</span>}
    </button>
    {unread && <Button variant="ghost" className="activity-mark-read" data-topology-control aria-label={t("activity.markRead")} title={t("activity.markRead")}
      onPointerDown={event => {
        event.stopPropagation();
        if (!event.isPrimary || event.button !== 0) return;
        cancelled.current = false;
        press.current = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={event => { event.stopPropagation(); move(event); }}
      onPointerUp={event => {
        event.stopPropagation(); move(event);
        if (press.current?.id !== event.pointerId) return;
        cancelled.current = press.current.moved;
        press.current = undefined;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={event => { event.stopPropagation(); press.current = undefined; cancelled.current = true; }}
      onLostPointerCapture={event => { event.stopPropagation(); if (press.current) { press.current = undefined; cancelled.current = true; } }}
      onKeyDown={event => event.stopPropagation()} onKeyUp={event => event.stopPropagation()}
      onClick={event => {
        event.stopPropagation();
        if (event.detail !== 0 && cancelled.current) { event.preventDefault(); return; }
        onRead();
      }}><Icon icon={Check} />{session.dispatchSummary?.controlSource && <SourceBadge source={session.dispatchSummary.controlSource} />}</Button>}
  </div>;
}
