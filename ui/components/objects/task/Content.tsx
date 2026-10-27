import { DispatchSpec } from "../../composites/DispatchSpec";
import { useReducedMotion } from "../../../state/appEnvironment";
import { useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { locale, t } from "../../../i18n";
import { PhaseTile, PhaseLabel, StepTrail, dispatchSourceLabel } from "../../activity";
import { activityHeadline, type TrackedActivity, type BubbleDensity } from "../../../state/activityModel";
import { useInterval } from "../../../state/hooks";
import FilePath from "../../FilePath";

/** Keep a project readable, or give its space to the task metadata. */
function ProjectChip({ name, path }: { name: string; path?: string | null }) {
  const ref = useRef<HTMLSpanElement>(null), [fits, setFits] = useState(true);
  useLayoutEffect(() => {
    const chip = ref.current, row = chip?.parentElement;
    if (!chip || !row) return;
    const measure = () => {
      const siblings = Array.from(row.children).filter(node => node !== chip) as HTMLElement[];
      const widths = siblings.map(node => node.getBoundingClientRect().width);
      const gap = parseFloat(getComputedStyle(row).columnGap) || 0;
      setFits(chip.getBoundingClientRect().width + widths.reduce((sum, width) => sum + width, 0) + gap * widths.length <= row.clientWidth);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(row); resize.observe(chip);
    const changes = new MutationObserver(measure);
    changes.observe(row, { childList: true, subtree: true, characterData: true });
    measure();
    return () => { resize.disconnect(); changes.disconnect(); };
  }, [name]);
  return <span ref={ref} aria-hidden={!fits || undefined} className={`activity-project w-max shrink-0 whitespace-nowrap rounded-full border px-1.5 text-xs text-muted-foreground ${fits ? '' : 'pointer-events-none absolute invisible'}`} title={path ?? undefined}>{name}</span>;
}

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
  return <span className={`activity-headline grid min-w-0 flex-1 text-xs leading-4 [&>span]:col-start-1 [&>span]:row-start-1 [&>span]:min-w-0 [&>span]:truncate ${!headline.fallback && (display.phase === "command" || !!headline.path) ? "font-mono" : ""} ${headline.fallback ? "text-muted-foreground" : "text-foreground"}`}>
    <AnimatePresence initial={false}>
      <motion.span key={`${display.phase}:${headline.text}`} initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 5 }} animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: reduced ? 0 : -5 }} transition={{ duration: reduced ? 0 : 0.16 }}>
        {headline.path ? <FilePath path={headline.path} project={display.project} /> : headline.text}
      </motion.span>
    </AnimatePresence>
  </span>;
}
export function ActivityBubbleContent({ agent, session, now, density = "standard", historical = false, conversationRow = false, showSourceBadge = true }: { agent: string; session: TrackedActivity; now: number; density?: BubbleDensity; historical?: boolean; conversationRow?: boolean; showSourceBadge?: boolean }) {
  const language = locale.use();
  const paused = ["cancelled", "interrupted", "aborted"].includes(session.status ?? "");
  const completed = !paused && (session.endedAt !== undefined || historical), external = session.source === "transcript";
  const running = !paused && !completed && !external && !session.interaction && session.phase !== "idle";
  const unread = completed && !historical && session.readAt === undefined;
  const phase = session.interaction ? "interaction" : session.phase;
  const phaseLabel = completed ? "activity.completed" : session.interaction ? "activity.waitingConfirm" : `activity.phase.${phase}`;
  const source = session.dispatchSummary?.controlSource;
  const project = (session.projectName || session.project)?.replace(/[\\/]+$/, "").split(/[\\/]/).pop();
  const previous = session.recentContent?.filter(text => text !== activityHeadline(session).text).at(-1);
  const duration = elapsed(session.turnStartedAt, session.endedAt ?? now);
  const detail = session.interaction ? t("activity.pendingHint") : completed ? duration === "—" ? undefined : t("activity.totalDuration", { duration }) : previous;
  const created = Date.parse(session.startedAt ?? "");
  const conversation = conversationRow;
  const createdTime = Number.isFinite(created) && <time className="activity-created ml-auto shrink-0 whitespace-nowrap text-xs text-muted-foreground" dateTime={session.startedAt!}
    title={t("agentPanel.created", { time: new Date(created).toLocaleString(language) })}>
    {new Date(created).toLocaleDateString(language, { ...(new Date(created).getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } as const : {}), month: "short", day: "numeric" })}
  </time>;
  return <>
    <PhaseTile phase={phase} running={running} completed={completed} paused={paused} animated={!external} source={showSourceBadge ? source : undefined} />
    {historical && <span className="sr-only">{t(paused ? "timeline.status.cancelled" : "activity.completed")}</span>}
    <span className="activity-copy flex min-w-0 flex-1 flex-col gap-0.5">
      <span className="activity-title-row flex min-w-0 items-center gap-1 [&>strong]:min-w-0 [&>strong]:flex-1 [&>strong]:truncate [&>strong]:text-sm [&>strong]:font-semibold [&>time]:shrink-0 [&>time]:font-mono [&>time]:text-xs [&>time]:text-muted-foreground [&>time]:tabular-nums"><strong>{session.title || t("timeline.title")}</strong>
        {unread && <span className="activity-unread size-1.5 shrink-0 rounded-full bg-brand-accent" role="img" aria-label={t("activity.unread")} />}
        {session.interaction ? <span className="activity-pending shrink-0 rounded-full bg-warning-soft px-1.5 text-xs text-warning">{t("activity.pending")}</span> : !historical && <time className="[[data-compact]_&]:hidden">{elapsed(session.turnStartedAt, session.endedAt ?? now)}</time>}
      </span>
      {(!historical || !conversation) && <span className="activity-phase flex min-w-0 items-center gap-1 text-xs font-medium whitespace-nowrap text-muted-foreground [&>.phase-label]:max-w-2/5 [&>.phase-label]:shrink-0">
        {historical ? createdTime : <>
          <PhaseLabel phase={phase} running={running} completed={completed}>{t(phaseLabel)}</PhaseLabel>
          <Headline session={session.interaction ? { ...session, headline: session.interaction.summary } : session} />
        </>}
      </span>}
      {density === "detailed" && <span className="activity-detail-line truncate text-xs leading-4 text-muted-foreground" title={detail}>{detail || "\u00a0"}</span>}
      {density !== "compact" && <span className={`activity-spec-row relative flex min-w-0 items-center gap-1 text-xs [&>.step-trail]:ml-auto ${conversation ? "activity-conversation-meta" : ""}`}>
        {conversation && project && <ProjectChip name={project} path={session.project} />}
        <DispatchSpec agent={agent} record={{ kind: "session", value: session }} variant="inline" />
        {conversation && !!session.turnCount && <span className="activity-spec inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 text-xs text-muted-foreground">{t("timeline.turnCount", { count: session.turnCount })}</span>}
        {!conversation && project && <ProjectChip name={project} path={session.project} />}
        {density === "detailed" && source && <span className="activity-source-name min-w-0 max-w-1/4 truncate text-muted-foreground" title={dispatchSourceLabel(source)}>{dispatchSourceLabel(source)}</span>}
        {conversation ? createdTime : <StepTrail steps={session.recentSteps} running={running} />}
      </span>}
    </span>
  </>;
}
