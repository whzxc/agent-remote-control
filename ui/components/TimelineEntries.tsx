import { motionTransition } from "../motion/tokens";
import { Tooltip as HoverHelp } from "./ui/index";
import { TaskReceiptHistory } from "./TaskNeedsYou";
import { AgentPhaseTile, TaskCard, TaskMessage } from "./ui/TaskPresentation";
import { ChangedFiles } from "./TaskChanges";
import TaskOutcome from "./TaskOutcome";
import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Brain, Copy, Check, ChevronRight, Circle, FileText, ListChecks, MessageSquare, ShieldAlert, Terminal, UserRound, Wrench } from "lucide-react";
import { Collapsible } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { locale, t } from "../i18n";
import { useMedia } from "../state/hooks";
import type { AgentActivitySession, AgentTimelineEntry, DispatchSummary, TurnTiming } from "../types";
import { activityApprovals } from "../state/activity";
import { filePathParts, interactionKey } from "../state/activityModel";
import { entryDuration, timelineGroups, turnDuration, type TimelineGroup } from "../state/timelineGroups";
import { Button, Icon, IconButton } from "./ui";
import { dispatchSourceLabel, PhaseLabel } from "./activity";
import { icons } from "../state/agents";
import { answerLabel, interactionSummary, pendingSessions } from "../state/taskInteractions";
import { copyText } from "../platform";
import { processOpen, projectTurn, taskState, toolSummary, type ProcessRow } from "../state/taskProjection";
import { taskErrorText } from "../state/taskErrors";
import FilePath from "./FilePath";
import TimelineMarkdown, { TimelineResources } from "./TimelineMarkdown";

const stepIcons = { command: Terminal, file: FileText, tool: Wrench, thinking: Brain, text: MessageSquare, user: UserRound, plan: ListChecks, interaction: ShieldAlert, error: AlertCircle, notice: MessageSquare };
export function durationText(value: number) {
  if (value < 1000) return t("activity.milliseconds", { count: Math.floor(value) });
  const seconds = Math.floor(value / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return t(hours ? "timeline.durationHours" : minutes ? "timeline.durationMinutes" : "activity.seconds",
    { hours, minutes: minutes % 60, seconds: seconds % 60, count: seconds });
}
function Fold({ open, onChange, summary, children, className = "", expandable = true }: {
  open: boolean; onChange: (open: boolean) => void; summary: ReactNode; children: ReactNode; className?: string; expandable?: boolean;
}) {
  const reduced = useMedia("(prefers-reduced-motion: reduce)");
  if (!expandable) return <div className={`timeline-fold ${className}`}><div className="timeline-summary">{summary}</div></div>;
  return <Collapsible.Root open={open} onOpenChange={onChange} className={`timeline-fold ${className}`}>
    <Collapsible.Trigger className="timeline-summary" type="button">
      {summary}<Icon icon={ChevronRight} className="timeline-chevron" />
    </Collapsible.Trigger>
    {reduced ? open && <Collapsible.Content className="timeline-fold-content">{children}</Collapsible.Content> : <AnimatePresence initial={false}>
      {open && <Collapsible.Content forceMount asChild>
        <motion.div className="timeline-fold-content" initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ ...motionTransition("panel"), duration: reduced ? 0 : motionTransition("panel").duration }}>
          {children}
        </motion.div>
      </Collapsible.Content>}
    </AnimatePresence>}
  </Collapsible.Root>;
}
function UserMessage({ text, truncated, open, onChange }: { text: string; truncated?: boolean; open: boolean; onChange: (open: boolean) => void }) {
  const id = useId(), content = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState(false);
  useLayoutEffect(() => {
    const node = content.current;
    if (!node) return;
    const measure = () => {
      if (node.clientWidth) setOverflow(node.scrollHeight > node.clientHeight + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text]);
  return <TaskMessage className="timeline-user" aria-label={t("timeline.user")}>
    <div id={id} className="timeline-user-content">
      <div ref={content} className="timeline-user-preview" data-expanded={open || undefined} aria-hidden={open || undefined}>{text.replace(/\n\s*\n/g, "\n")}</div>
      {open && <TimelineMarkdown text={text} />}
      {truncated && <span className="timeline-meta">{t("timeline.truncated")}</span>}
    </div>
    {overflow && <Button variant="ghost" className="timeline-user-toggle" aria-expanded={open} aria-controls={id} onClick={() => onChange(!open)}>
      {t(open ? "timeline.showLess" : "timeline.showMore")}
    </Button>}
  </TaskMessage>;
}
function ToolTitle({ entry, project }: { entry: AgentTimelineEntry; project?: string | null }) {
  return <HoverHelp text={entry.command || entry.path || entry.title}><span className="timeline-entry-title mono">
    {entry.path && !entry.command ? <FilePath path={entry.path} project={project || entry.cwd} /> : entry.command || entry.title || t(entry.type === "command" ? "activity.phase.command" : entry.type === "file" ? "activity.phase.file" : "activity.phase.tool")}
  </span></HoverHelp>;
}
function ToolDetails({ entry, project }: { entry: AgentTimelineEntry; project?: string | null }) {
  return <div className="timeline-output">
    {entry.cwd && <section><span className="timeline-meta">{t("timeline.cwd")}</span><div className="mono">{entry.cwd}</div></section>}
    {entry.path && <section><span className="timeline-meta">{t("timeline.path")}</span><div className="mono">{filePathParts(entry.path, project || entry.cwd).fullPath}</div></section>}
    {!!entry.changes?.length && <section><span className="timeline-meta">{t("timeline.changes")}</span><ul className="timeline-files">{entry.changes.map((change, index) => <li key={`${change.path}:${index}`}>
      <FilePath path={change.path} project={project || entry.cwd} />
    </li>)}</ul></section>}
    {entry.input?.text && <section><span className="timeline-meta">{t("timeline.input")}</span><pre>{entry.input.text}</pre></section>}
    {(entry.output?.text || entry.text) && <section><span className="timeline-meta">{t("timeline.output")}</span><pre>{entry.output?.text || entry.text}</pre></section>}
    {entry.exitCode !== undefined && <div className="timeline-meta">{t("timeline.exitCode", { code: entry.exitCode })}</div>}
    {(entry.truncated || entry.input?.truncated || entry.output?.truncated) && <span className="timeline-meta">{t("timeline.truncated")}</span>}
  </div>;
}
function CopyReply({ text }: { text: string }) {
  const [error, setError] = useState("");
  return <><IconButton compact icon={Copy} label={t("detail.copyReply")} onClick={() => void copyText(text).catch(() => setError(t("copyFailedSelectAndCopyTheTextManually")))} />{error && <span role="alert">{error}</span>}</>;
}
function InteractionAnchor({ entry, agent, session }: { entry: AgentTimelineEntry; agent: string; session: AgentActivitySession }) {
  const submissions = activityApprovals.use();
  const receipt = submissions[interactionKey(agent, { ...session, phaseSince: entry.startedAt, interaction: entry.interaction })];
  const saved = entry.response;
  const own = !!saved || receipt?.status === "submitted";
  const resolved = own || entry.status === "completed";
  const answer = saved ? answerLabel({ op: "codex_respond", args: { result: saved.result } }) : receipt?.status === "submitted" ? answerLabel(receipt.payload) : "";
  const decision = saved?.result?.decision;
  const verdict = !own ? "timeline.resolved" : saved
    ? saved.skipped ? "detail.skipped" : decision ? ["decline", "cancel", "denied"].includes(decision) ? "detail.verdict.reject" : "detail.verdict.approved"
      : answer ? "timeline.answered" : "detail.skipped"
    : receipt?.decision === "deny" ? "detail.verdict.reject" : receipt?.decision === "allow" ? "detail.verdict.approved" : receipt?.decision === "cancel" ? "detail.skipped" : "timeline.answered";
  return <div className="task-interaction-anchor" data-pending={!resolved || undefined}>
    <Icon icon={resolved ? Check : ShieldAlert} /><div><strong>{resolved ? t(verdict) : t("detail.needsYou")}</strong>
      <span>{interactionSummary(entry.interaction)}</span>{answer && <span>{answer}</span>}
      {resolved && <small>{saved ? saved.origin.controlSource === "ARC" ? t("detail.byARC") : saved.origin.sourceLabel || saved.origin.controlSource || t("detail.sourceUnknown") : own ? t("detail.byARC") : t("detail.resolvedElsewhere")}</small>}
    </div>
  </div>;
}
function PlanEntry({ entry, settled }: { entry: AgentTimelineEntry; settled: boolean }) {
  const steps = entry.plan ?? [];
  return <section className="task-plan" aria-label={t("timeline.plan")} data-settled={settled || undefined}>
    <header><Icon icon={ListChecks} /><span>{t("timeline.plan")}</span><span>{steps.filter(step => step.status === "completed").length}/{steps.length}</span></header>
    <ul>{steps.map((step, index) => <li key={index} data-state={step.status}><Icon icon={step.status === "completed" ? Check : Circle} /><span>{step.content.text}</span></li>)}</ul>
  </section>;
}
function ProcessEntry({ entry, agent, session, settled }: { entry: AgentTimelineEntry; agent: string; session: AgentActivitySession; settled: boolean }) {
  if (entry.type === "notice") return null;
  if (entry.type === "text") return <article className="task-phase"><AgentPhaseTile>{icons[agent] ? <span dangerouslySetInnerHTML={{ __html: icons[agent] }} /> : <Icon icon={MessageSquare} />}</AgentPhaseTile><div><TimelineMarkdown text={entry.text ?? ""} /></div></article>;
  if (entry.type === "user") return <div className="task-prompt">{entry.controlSource && <small>{t("detail.via", { source: dispatchSourceLabel(entry.controlSource) })}{entry.startedAt && ` · ${new Date(entry.startedAt).toLocaleTimeString(locale.get(), { hour: "2-digit", minute: "2-digit" })}`}</small>}<TaskMessage><TimelineMarkdown text={entry.text ?? ""} /></TaskMessage></div>;
  if (entry.type === "interaction") return <InteractionAnchor entry={entry} agent={agent} session={session} />;
  if (entry.type === "plan") return <PlanEntry entry={entry} settled={settled} />;
  return <p className="timeline-error">{taskErrorText(entry.text || entry.title, "detail.failureUnknown")}</p>;
}
function ToolEntry({ entry }: { entry: AgentTimelineEntry }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!(entry.output?.text || entry.input?.text || entry.text || entry.cwd || entry.path || entry.changes?.length || entry.truncated || entry.input?.truncated || entry.output?.truncated);
  return <div className="task-tool-row" data-failed={entry.status === "failed" || undefined}>
    <Fold className="task-tool-entry" open={open} onChange={setOpen} expandable={hasDetails}
      summary={<><Icon icon={stepIcons[entry.type]} /><ToolTitle entry={entry} /><span>{entry.exitCode !== undefined && t("timeline.exitCode", { code: entry.exitCode })}</span></>}>
      {!!entry.changes?.length && <ChangedFiles entries={[entry]} />}
      <ToolDetails entry={entry} />
    </Fold>
  </div>;
}
function ToolSummary({ entries }: { entries: AgentTimelineEntry[] }) {
  const { parts, more, failed } = toolSummary(entries);
  return <span className="task-tool-counts">
    {parts.map(part => <span key={part.kind} className="task-tool-count">{t(`detail.tools.${part.kind}`, { count: part.count })}</span>)}
    {more > 0 && <span className="task-tool-count">{t("detail.tools.more", { count: more })}</span>}
    {failed > 0 && <span className="task-tool-count" data-failed>{t("detail.tools.failed", { count: failed })}</span>}
  </span>;
}
// A lone tool is its own row; consecutive tools fold behind one summary line.
function ToolRun({ entries }: { entries: AgentTimelineEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 1) return <ToolEntry entry={entries[0]} />;
  return <Fold className="task-tool-run" open={open} onChange={setOpen} summary={<ToolSummary entries={entries} />}>
    <div className="task-tool-rows">{entries.map(entry => <ToolEntry key={entry.id} entry={entry} />)}</div>
  </Fold>;
}
function liveToolLabel(entry: AgentTimelineEntry, project?: string | null) {
  if (entry.path && !entry.command) return <FilePath path={entry.path} project={project || entry.cwd} />;
  return entry.command || entry.title || t(entry.type === "file" ? "activity.phase.file" : entry.type === "command" ? "activity.phase.command" : "activity.phase.tool");
}
function LiveTool({ entry, now, project }: { entry: AgentTimelineEntry; now: number; project?: string | null }) {
  const [open, setOpen] = useState(true);
  const output = (entry.output?.text || entry.text || "").split("\n").slice(-8).join("\n").trim();
  const elapsed = entryDuration(entry, now);
  const phase = entry.type as "command" | "file" | "tool";
  return <div className="task-live-row" data-phase={phase}><Fold open={open} onChange={setOpen} expandable={!!output}
    summary={<><Icon icon={stepIcons[phase]} /><span className="task-live-label mono"><PhaseLabel phase={phase} running>{liveToolLabel(entry, project)}</PhaseLabel></span>
      {elapsed !== undefined && <time className="timeline-meta">{durationText(elapsed)}</time>}</>}>
    <pre className="task-live-log">{output}</pre>
  </Fold></div>;
}
// The live row anchors the bottom of a running turn: what runs now, or what the agent is thinking about.
function LiveActivity({ activity, now, project }: { activity: NonNullable<ReturnType<typeof projectTurn>["activity"]>; now: number; project?: string | null }) {
  if (activity.running.length) return <>{activity.running.map(entry => <LiveTool key={entry.id} entry={entry} now={now} project={project} />)}</>;
  return <div className="task-live-row" data-phase="thinking"><div className="timeline-fold"><div className="timeline-summary"><Icon icon={Brain} />
    <span className="task-live-label" role="status"><PhaseLabel phase="thinking" running>{activity.thought || t("activity.phase.thinking")}</PhaseLabel></span></div></div></div>;
}
function processLabel(state: ReturnType<typeof taskState>, duration?: number) {
  if (duration === undefined) return t("detail.worked");
  const value = durationText(duration);
  return state === "failed" ? t("detail.failedAfter", { duration: value }) : state === "interrupted" ? t("detail.stoppedAfter", { duration: value }) : t("detail.workedFor", { duration: value });
}
type TurnProps = {
  group: TimelineGroup; index: number; latest: boolean; current: boolean; live: boolean; agent: string;
  session: AgentActivitySession & { selectedTurnId?: string }; now: number; status?: string; timing?: TurnTiming;
  onResume?: () => void; onRetry?: () => void; continuing?: boolean;
};
const sameEntries = (a: readonly AgentTimelineEntry[], b: readonly AgentTimelineEntry[]) => a.length === b.length && a.every((entry, index) => entry === b[index]);
// Settled turns skip the one-second clock and unrelated polls; only the live turn re-renders.
function sameTurn(a: TurnProps, b: TurnProps) {
  return !a.live && !b.live && a.group.id === b.group.id && sameEntries(a.group.entries, b.group.entries) && a.index === b.index
    && a.latest === b.latest && a.current === b.current && a.agent === b.agent && a.status === b.status
    && a.timing?.startedAt === b.timing?.startedAt && a.timing?.endedAt === b.timing?.endedAt
    && a.session.id === b.session.id && a.session.project === b.session.project && a.session.selectedTurnId === b.session.selectedTurnId
    && a.onResume === b.onResume && a.onRetry === b.onRetry && a.continuing === b.continuing;
}
const TurnCard = memo(function TurnCard({ group, index, latest, current, live, agent, session, now, status, timing, onResume, onRetry, continuing }: TurnProps) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const submissions = activityApprovals.use();
  const change = (id: string) => (open: boolean) => setExpanded(previous => ({ ...previous, [id]: open }));
  const pending = live && pendingSessions(agent, session, group.entries, submissions).length > 0;
  const state = taskState(status, live, pending);
  const projection = projectTurn(group.entries, state);
  const { prompt, final, rows, activity } = projection;
  const duration = turnDuration(group.entries, now, live, latest && current ? session.turnStartedAt : undefined, timing);
  const source = prompt?.controlSource;
  const workId = `process:${state}`, turnOpen = (session.selectedTurnId ? group.turnId === session.selectedTurnId : latest) || pending || (expanded.turn ?? false);
  const failedTools = state === "failed" ? group.entries.filter(entry => ["command", "file", "tool"].includes(entry.type) && entry.status === "failed") : [];
  const failure = [...group.entries].reverse().find(entry => entry.type === "error" || entry.status === "failed");
  const visibleRows = rows.flatMap((row): ProcessRow[] => row.kind === "tools"
    ? row.entries.some(entry => !failedTools.includes(entry)) ? [{ ...row, entries: row.entries.filter(entry => !failedTools.includes(entry)) }] : []
    : pending && row.entry.type === "interaction" || state === "failed" && row.entry.type === "error" && row.entry.text === failure?.text ? [] : [row]);
  const settled = !live;
  const blocks: ReactNode[] = [];
  for (let i = 0; i < visibleRows.length; i++) {
    const row = visibleRows[i];
    if (row.kind !== "tools") { blocks.push(<ProcessEntry key={row.id} entry={row.entry} agent={agent} session={session} settled={settled} />); continue; }
    // Rows filtered out between tool runs leave adjacent runs; keep them on one line.
    const adjacent = [row];
    while (visibleRows[i + 1]?.kind === "tools") adjacent.push(visibleRows[++i] as Extract<ProcessRow, { kind: "tools" }>);
    blocks.push(<div className="task-tool-groups" key={row.id}>{adjacent.map(run => <ToolRun key={run.id} entries={run.entries} />)}</div>);
  }
  const process = <div className="task-process-rows">{blocks}{activity && !pending && <LiveActivity activity={activity} now={now} project={session.project} />}</div>;
  const processSummary = <span className="task-process-summary"><span>{processLabel(state, duration)}</span>
    {!!projection.actions && <span>{t("detail.process.actions", { count: projection.actions })}</span>}
    {!!projection.failed && state !== "failed" && <span data-failed>{t("detail.tools.failed", { count: projection.failed })}</span>}</span>;
  const processTrigger = <Collapsible.Trigger className="timeline-summary task-process-trigger" type="button">{processSummary}<Icon icon={ChevronRight} className="timeline-chevron" /></Collapsible.Trigger>;
  const hasProcess = !!visibleRows.length || !!activity;
  return <Collapsible.Root open={live || processOpen(state, expanded[workId])} onOpenChange={change(workId)} asChild><TaskCard className="task-turn" data-timeline-id={group.id} data-turn-collapsed={!turnOpen || undefined} onClick={event => {
    if (!turnOpen && !(event.target as Element).closest("button, a, input")) change("turn")(true);
  }}>
    {!latest && <div className="task-turn-heading">
      <button type="button" className="task-previous-turn" aria-expanded={turnOpen} onClick={() => change("turn")(!turnOpen)}>
        <span>{t("detail.previousTurn", { turn: index + 1, count: projection.actions })}{duration !== undefined && ` · ${durationText(duration)}`}</span>
        {!turnOpen && <span>{final?.text?.trim().split("\n")[0] || t("detail.noFinalReply")}</span>}
        <Icon icon={ChevronRight} className="timeline-chevron" />
      </button>
      {turnOpen && !!visibleRows.length && processTrigger}
    </div>}
    {projection.answeredInteractions.map(entry => <InteractionAnchor key={entry.id} entry={entry} agent={agent} session={session} />)}
    {turnOpen && <div className="task-turn-content">
      {prompt && <div className="task-prompt">{source && <small>{t("detail.via", { source: dispatchSourceLabel(source) })}{prompt.startedAt && ` · ${new Date(prompt.startedAt).toLocaleTimeString(locale.get(), { hour: "2-digit", minute: "2-digit" })}`}</small>}
        <UserMessage text={prompt.text ?? ""} truncated={prompt.truncated} open={expanded[prompt.id] ?? false} onChange={change(prompt.id)} /></div>}
      {hasProcess && (live ? process : <div className="task-process">{latest && processTrigger}<Collapsible.Content>{process}</Collapsible.Content></div>)}
      {(state === "failed" || state === "interrupted") && <TaskOutcome state={state} entries={group.entries} project={session.project} onResume={latest && current ? onResume : undefined} onRetry={latest && current ? onRetry : undefined} continuing={continuing}
        failedTools={failedTools.length ? <ToolRun entries={failedTools} /> : undefined} />}
      <TaskReceiptHistory agent={agent} id={session.id} turnId={group.turnId} latest={latest} />
      {final && state !== "failed" && state !== "interrupted" && <TaskCard reply className="task-final"><header><Icon icon={Check} /><strong>{t("detail.finalReply")}</strong><CopyReply text={final.text ?? ""} /></header><TimelineMarkdown text={final.text ?? ""} />{final.truncated && <span className="timeline-meta">{t("timeline.truncated")}</span>}<ChangedFiles entries={group.entries} project={session.project} /></TaskCard>}
    </div>}
  </TaskCard></Collapsible.Root>;
}, sameTurn);
export default function TimelineEntries({ entries, agent, session, now, running = false, turnStatuses, turnTimings, status, onResume, onRetry, continuing }: {
  entries: AgentTimelineEntry[]; agent: string; session: AgentActivitySession & { selectedTurnId?: string }; now: number; running?: boolean; turnDispatchSummaries?: Record<string, DispatchSummary>; turnStatuses?: Record<string, string>; status?: string; turnTimings?: Record<string, TurnTiming>;
  onResume?: () => void; onRetry?: () => void; continuing?: boolean;
}) {
  const groups = timelineGroups(entries);
  return <TimelineResources agent={agent} id={session.id}>{groups.map((group, index) => {
    const latest = index === groups.length - 1;
    const current = !session.turnId || !group.turnId || group.turnId === session.turnId;
    const live = latest && current && running;
    return <TurnCard key={group.id} group={group} index={index} latest={latest} current={current} live={live} agent={agent} session={session}
      now={live ? now : 0} status={(group.turnId ? turnStatuses?.[group.turnId] : undefined) ?? (latest && current ? status : undefined)}
      timing={group.turnId ? turnTimings?.[group.turnId] : undefined}
      onResume={latest && current ? onResume : undefined} onRetry={latest && current ? onRetry : undefined} continuing={latest && current ? continuing : undefined} />;
  })}</TimelineResources>;
}
