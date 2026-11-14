import { motionTransition } from "../motion/tokens";
import { Tooltip as HoverHelp } from "./ui/index";
import { TaskReceiptHistory } from "./TaskNeedsYou";
import { TaskCard, TaskMessage } from "./ui/TaskPresentation";
import { ChangedFiles } from "./TaskChanges";
import TaskOutcome from "./TaskOutcome";
import { memo, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Brain, Copy, Check, ChevronRight, CircleCheck, CircleX, ShieldCheck, Circle, FileText, ListChecks, MessageSquare, ShieldAlert, Terminal, UserRound, Wrench, type LucideIcon } from "lucide-react";
import { Collapsible } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { t } from "../i18n";
import { useMedia } from "../state/hooks";
import type { AgentActivitySession, AgentTimelineEntry, DispatchSummary, TurnTiming } from "../types";
import { activityApprovals } from "../state/activity";
import { filePathParts, interactionKey } from "../state/activityModel";
import { entryDuration, timelineGroups, turnDuration, type TimelineGroup } from "../state/timelineGroups";
import { Button, Icon, IconButton } from "./ui";
import { SourceBadge, dispatchSourceLabel, PhaseLabel } from "./activity";
import RelayRoute from "./RelayRoute";
import TaskNeedsYou from "./TaskNeedsYou";
import { answerLabel, interactionSummary, pendingSessions } from "../state/taskInteractions";
import { copyText } from "../platform";
import { processOpen, projectTurn, taskState, toolSummary, thoughtLine } from "../state/taskProjection";
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
function RailStep({ icon, phase, live, children }: { icon?: LucideIcon; phase?: string; live?: boolean; children: ReactNode }) {
  return <li className="relay-step" data-phase={phase} data-live={live || undefined}>
    <span className="relay-step-node" aria-hidden="true">{icon ? <Icon icon={icon} size={13} /> : <span className="relay-step-dot" />}</span>
    <div className="relay-step-content">{children}</div>
  </li>;
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
    {!!entry.changes?.length && <section><span className="timeline-meta">{t("timeline.changes")}</span><ul className="timeline-files" aria-label={t("timeline.changes")}>{entry.changes.map((change, index) => <li key={`${change.path}:${index}`}>
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
  const by = saved?.answeredBy;
  const source = by?.kind === "source" ? { id: by.sourceId, kind: by.brand, label: by.label } : undefined;
  const byLabel = by?.kind === "local-ui" ? "ARC" : source ? dispatchSourceLabel(source) : "";
  const target = entry.interaction?.command || entry.interaction?.path || interactionSummary(entry.interaction);
  return <RailStep icon={resolved ? ShieldCheck : ShieldAlert} phase={resolved ? "completed" : "interaction"}>
    <div className="task-interaction-anchor" data-pending={!resolved || undefined}>
      <div className="task-interaction-line">{source && <SourceBadge inline source={source} />}<strong>{resolved ? byLabel && verdict === "detail.verdict.approved" ? t("relay.approvedBy", { source: byLabel }) : t(verdict) : t("detail.needsYou")}</strong>
        <span aria-hidden="true">·</span><HoverHelp text={target}><span className="task-interaction-target mono">{target}</span></HoverHelp>
      </div>{answer && !decision && <span>{answer}</span>}
    </div>
  </RailStep>;
}
function PlanEntry({ entry, settled }: { entry: AgentTimelineEntry; settled: boolean }) {
  const steps = entry.plan ?? [];
  return <section className="task-plan" aria-label={t("timeline.plan")} data-settled={settled || undefined}>
    <header><Icon icon={ListChecks} /><span>{t("timeline.plan")}</span><span>{steps.filter(step => step.status === "completed").length}/{steps.length}</span></header>
    <ul>{steps.map((step, index) => <li key={index} data-state={step.status}><Icon icon={step.status === "completed" ? Check : Circle} /><span>{step.content.text}</span></li>)}</ul>
  </section>;
}
function ThoughtEntry({ entry }: { entry: AgentTimelineEntry }) {
  const [open, setOpen] = useState(false);
  return <RailStep icon={Brain} phase="thinking"><Fold className="relay-thought" open={open} onChange={setOpen} summary={<><span>{t("relay.thought")} · {thoughtLine(entry.text || entry.title || "")}</span>{entry.durationMs !== undefined && <time>{durationText(entry.durationMs)}</time>}</>}>
    <TimelineMarkdown text={entry.text || entry.title || ""} />
  </Fold></RailStep>;
}
function Prompt({ entry, agent, followup = false }: { entry: AgentTimelineEntry; agent: string; followup?: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="relay-message" data-neutral={!entry.controlSource || undefined}>
    {entry.controlSource ? <RelayRoute source={entry.controlSource} agent={agent} label={t(followup ? "relay.followup" : "relay.dispatch")} /> : <span className="timeline-meta">{t("relay.prompt")}</span>}
    <UserMessage text={entry.text ?? ""} truncated={entry.truncated} open={open} onChange={setOpen} />
  </div>;
}
function ProcessEntry({ entry, agent, session, streaming }: { entry: AgentTimelineEntry; agent: string; session: AgentActivitySession; streaming?: boolean }) {
  if (entry.type === "notice" || entry.type === "plan") return null;
  if (entry.type === "thinking") return <ThoughtEntry entry={entry} />;
  if (entry.type === "text") return <RailStep><article className="relay-narration" data-streaming={streaming || undefined}><TimelineMarkdown text={entry.text ?? ""} /></article></RailStep>;
  if (entry.type === "user") return <RailStep icon={UserRound}><Prompt entry={entry} agent={agent} followup /></RailStep>;
  if (entry.type === "interaction") return <InteractionAnchor entry={entry} agent={agent} session={session} />;
  return <RailStep icon={CircleX} phase="failed"><p className="timeline-error">{taskErrorText(entry.text || entry.title, "detail.failureUnknown").split("\n")[0]}</p></RailStep>;
}
export function TimelinePlanDock({ entry }: { entry: AgentTimelineEntry }) {
  const [open, setOpen] = useState(false);
  const steps = entry.plan ?? [], completed = steps.filter(step => step.status === "completed").length;
  const current = steps.find(step => ["in_progress", "inProgress", "running"].includes(step.status)) ?? steps.find(step => step.status !== "completed");
  return <Collapsible.Root className="relay-plan-dock" open={open} onOpenChange={setOpen}>
    <Collapsible.Content><PlanEntry entry={entry} settled={false} /></Collapsible.Content>
    <Collapsible.Trigger className="timeline-summary"><Icon icon={ListChecks} /><span>{t("timeline.plan")} {completed}/{steps.length}</span><span className="relay-plan-current">{current?.content.text}</span>
      <progress aria-label={t("timeline.plan")} value={completed} max={steps.length} /><Icon icon={ChevronRight} className="timeline-chevron" /></Collapsible.Trigger>
  </Collapsible.Root>;
}
function ToolEntry({ entry, rail = false }: { entry: AgentTimelineEntry; rail?: boolean }) {
  const [open, setOpen] = useState(false);
  const hasDetails = !!(entry.output?.text || entry.input?.text || entry.text || entry.cwd || entry.path || entry.changes?.length || entry.truncated || entry.input?.truncated || entry.output?.truncated);
  return <div className="task-tool-row" data-failed={entry.status === "failed" || undefined}>
    <Fold className="task-tool-entry" open={open} onChange={setOpen} expandable={hasDetails}
      summary={<>{!rail && <Icon icon={stepIcons[entry.type]} />}<ToolTitle entry={entry} /><span className="task-added">{entry.changes?.some(c => c.added !== undefined) && `+${entry.changes.reduce((n, c) => n + (c.added ?? 0), 0)}`}</span><span className="task-removed">{entry.changes?.some(c => c.removed !== undefined) && `−${entry.changes.reduce((n, c) => n + (c.removed ?? 0), 0)}`}</span><span>{entry.exitCode !== undefined && t("timeline.exitCode", { code: entry.exitCode })}</span></>}>
      {!!entry.changes?.length && <ChangedFiles entries={[entry]} />}
      <ToolDetails entry={entry} />
    </Fold>
    {entry.status === "failed" && <p className="relay-error-line">{(entry.output?.text || entry.text || entry.title || "").split("\n").find(line => line.trim())}</p>}
  </div>;
}
function ToolSummary({ entries }: { entries: AgentTimelineEntry[] }) {
  const { parts, more, failed } = toolSummary(entries);
  const changes = entries.flatMap(entry => entry.changes ?? []);
  return <span className="task-tool-counts">
    {parts.map(part => <span key={part.kind} className="task-tool-count">{t(`detail.tools.${part.kind}`, { count: part.count })}</span>)}
    {more > 0 && <span className="task-tool-count">{t("detail.tools.more", { count: more })}</span>}
    {changes.some(change => change.added !== undefined) && <span className="task-added">+{changes.reduce((sum, change) => sum + (change.added ?? 0), 0)}</span>}
    {changes.some(change => change.removed !== undefined) && <span className="task-removed">−{changes.reduce((sum, change) => sum + (change.removed ?? 0), 0)}</span>}
    {failed > 0 && <span className="task-tool-count" data-failed>{t("detail.tools.failed", { count: failed })}</span>}
  </span>;
}
// A lone tool is its own row; consecutive tools fold behind one summary line.
function ToolRun({ entries }: { entries: AgentTimelineEntry[] }) {
  const [open, setOpen] = useState(false);
  if (entries.length === 1) return <RailStep icon={entries[0].status === "failed" ? CircleX : stepIcons[entries[0].type]} phase={entries[0].status === "failed" ? "failed" : entries[0].type}><ToolEntry entry={entries[0]} rail /></RailStep>;
  return <RailStep icon={Wrench} phase="tool"><Fold className="task-tool-run" open={open} onChange={setOpen} summary={<ToolSummary entries={entries} />}>
    <div className="task-tool-rows">{entries.map(entry => <ToolEntry key={entry.id} entry={entry} />)}</div>
  </Fold></RailStep>;
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
  return <RailStep icon={stepIcons[phase]} phase={phase} live><div className="task-live-row" data-phase={phase}><Fold open={open} onChange={setOpen} expandable={!!output}
    summary={<><span className="task-live-label mono"><PhaseLabel phase={phase} running>{liveToolLabel(entry, project)}</PhaseLabel></span>
      {elapsed !== undefined && <time className="timeline-meta">{durationText(elapsed)}</time>}</>}>
    <pre className="task-live-log">{output}</pre>
  </Fold></div></RailStep>;
}
// The live row anchors the bottom of a running turn: what runs now, or what the agent is thinking about.
function LiveActivity({ activity, now, project, elapsed }: { activity: NonNullable<ReturnType<typeof projectTurn>["activity"]>; now: number; project?: string | null; elapsed?: number }) {
  if (activity.running.length) {
    const last = activity.running.at(-1)!;
    const entry = activity.running.length === 1 ? last : { ...last, command: undefined, path: undefined,
      title: activity.running.map(row => row.command || row.path || row.title).filter(Boolean).join(" · "),
      startedAt: activity.running[0].startedAt,
      output: { ...last.output!, text: activity.running.map(row => row.output?.text || row.text || "").filter(Boolean).join("\n") } };
    return <LiveTool entry={entry} now={now} project={project} />;
  }
  return <RailStep icon={Brain} phase="thinking" live><div className="task-live-row" data-phase="thinking"><div className="timeline-fold"><div className="timeline-summary">
    <span className="task-live-label" role="status"><PhaseLabel phase="thinking" running>{activity.thought || t("activity.phase.thinking")}</PhaseLabel></span>{elapsed !== undefined && <time>{durationText(elapsed)}</time>}</div></div></div></RailStep>;
}
function processLabel(duration?: number) {
  return duration === undefined ? t("detail.worked") : t("detail.workedFor", { duration: durationText(duration) });
}

type TurnProps = {
  narrow?: boolean; group: TimelineGroup; index: number; latest: boolean; current: boolean; live: boolean; agent: string;
  session: AgentActivitySession & { selectedTurnId?: string }; now: number; status?: string; timing?: TurnTiming;
  onResume?: () => void; onRetry?: () => void; continuing?: boolean;
};
const sameEntries = (a: readonly AgentTimelineEntry[], b: readonly AgentTimelineEntry[]) => a.length === b.length && a.every((entry, index) => entry === b[index]);
// Settled turns skip the one-second clock and unrelated polls; only the live turn re-renders.
function sameTurn(a: TurnProps, b: TurnProps) {
  return !a.live && !b.live && a.group.id === b.group.id && sameEntries(a.group.entries, b.group.entries) && a.index === b.index
    && a.narrow === b.narrow && a.latest === b.latest && a.current === b.current && a.agent === b.agent && a.status === b.status
    && a.timing?.startedAt === b.timing?.startedAt && a.timing?.endedAt === b.timing?.endedAt
    && a.session.id === b.session.id && a.session.project === b.session.project && a.session.selectedTurnId === b.session.selectedTurnId
    && a.onResume === b.onResume && a.onRetry === b.onRetry && a.continuing === b.continuing;
}
const TurnCard = memo(function TurnCard({ narrow, group, index, latest, current, live, agent, session, now, status, timing, onResume, onRetry, continuing }: TurnProps) {
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
  const visibleRows = rows.filter(row => row.kind !== "entry" || !(pending && row.entry.type === "interaction" && !row.entry.response && row.entry.status !== "completed"));
  const newestNarration = [...group.entries].reverse().find(entry => entry.type === "text");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < visibleRows.length; i++) {
    const row = visibleRows[i];
    if (row.kind !== "tools") { blocks.push(<ProcessEntry key={row.id} entry={row.entry} agent={agent} session={session} streaming={live && row.entry === newestNarration && row.entry.status === "running"} />); continue; }
    blocks.push(<ToolRun key={row.id} entries={row.entries} />);
  }
  const process = <section className="relay-work">{live && <header><RelayRoute agent={agent} label={`${t(`detail.state.${state}`)}${duration !== undefined ? ` · ${durationText(duration)}` : ""}`} /></header>}<ol className="task-process-rows">{blocks}{activity && !pending && <LiveActivity activity={activity} now={now} project={session.project} elapsed={duration} />}</ol></section>;
  const processSummary = <span className="task-process-summary"><span>{processLabel(duration)}</span>
    <span>{t("detail.process.actions", { count: projection.actions })}</span>
    {!!projection.failed && state !== "failed" && <span data-failed>{t("detail.tools.failed", { count: projection.failed })}</span>}</span>;
  const processTrigger = <Collapsible.Trigger className="timeline-summary task-process-trigger" data-failed={state === "failed" || undefined} type="button"><Icon icon={state === "failed" ? CircleX : CircleCheck} size={14} />{processSummary}<Icon icon={ChevronRight} className="timeline-chevron" /></Collapsible.Trigger>;
  const hasProcess = !!visibleRows.length || !!activity;
  return <Collapsible.Root open={live || processOpen(state, expanded[workId])} onOpenChange={change(workId)} asChild><section className="task-turn" data-timeline-id={group.id} data-turn-collapsed={!turnOpen || undefined} onClick={event => {
    if (!turnOpen && !(event.target as Element).closest("button, a, input")) change("turn")(true);
  }}>
    {!latest && <div className="task-turn-heading">
      <button type="button" className="task-previous-turn" aria-expanded={turnOpen} onClick={() => change("turn")(!turnOpen)}>
        <span>{t("relay.turn", { count: index + 1 })}</span><RelayRoute source={source} agent={agent} marksOnly /><time>{duration !== undefined && durationText(duration)}</time>
        {!turnOpen && <span>{final?.text?.trim().split("\n")[0] || [...group.entries].reverse().find(entry => entry.type === "error" || entry.status === "failed")?.text?.split("\n")[0] || t(`detail.state.${state}`)}</span>}
        <Icon icon={ChevronRight} size={12} className="timeline-chevron" />
      </button>
      {turnOpen && !!visibleRows.length && processTrigger}
    </div>}
    {turnOpen && <div className="task-turn-content">
      {prompt && <Prompt entry={prompt} agent={agent} followup={index > 0} />}
      {hasProcess && (live ? process : <div className="task-process">{latest && processTrigger}<Collapsible.Content>{process}</Collapsible.Content></div>)}
      {pending && <TaskNeedsYou agent={agent} session={session} entries={group.entries} source={source} narrow={!!narrow} inline />}
      {(state === "failed" || state === "interrupted") && <TaskOutcome state={state} entries={group.entries} project={session.project} onResume={latest && current ? onResume : undefined} onRetry={latest && current ? onRetry : undefined} continuing={continuing} agent={agent} source={source} />}
      <TaskReceiptHistory agent={agent} id={session.id} turnId={group.turnId} latest={latest} />
      {final && state !== "failed" && state !== "interrupted" && <TaskCard reply className="task-final"><header><RelayRoute source={source} agent={agent} reverse label={t("relay.reply")} /><CopyReply text={final.text ?? ""} /></header><TimelineMarkdown text={final.text ?? ""} />{final.truncated && <span className="timeline-meta">{t("timeline.truncated")}</span>}<footer><ChangedFiles entries={group.entries} project={session.project} /></footer></TaskCard>}
    </div>}
  </section></Collapsible.Root>;
}, sameTurn);
export default function TimelineEntries({ narrow, entries, agent, session, now, running = false, turnStatuses, turnTimings, status, onResume, onRetry, continuing }: {
  narrow?: boolean; entries: AgentTimelineEntry[]; agent: string; session: AgentActivitySession & { selectedTurnId?: string }; now: number; running?: boolean; turnDispatchSummaries?: Record<string, DispatchSummary>; turnStatuses?: Record<string, string>; status?: string; turnTimings?: Record<string, TurnTiming>;
  onResume?: () => void; onRetry?: () => void; continuing?: boolean;
}) {
  const groups = timelineGroups(entries);
  return <TimelineResources agent={agent} id={session.id}>{groups.map((group, index) => {
    const latest = index === groups.length - 1;
    const current = !session.turnId || !group.turnId || group.turnId === session.turnId;
    const live = latest && current && running;
    return <TurnCard narrow={narrow} key={group.id} group={group} index={index} latest={latest} current={current} live={live} agent={agent} session={session}
      now={live ? now : 0} status={(group.turnId ? turnStatuses?.[group.turnId] : undefined) ?? (latest && current ? status : undefined)}
      timing={group.turnId ? turnTimings?.[group.turnId] : undefined}
      onResume={latest && current ? onResume : undefined} onRetry={latest && current ? onRetry : undefined} continuing={latest && current ? continuing : undefined} />;
  })}</TimelineResources>;
}
