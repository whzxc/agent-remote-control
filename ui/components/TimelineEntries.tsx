import { TaskReceiptHistory } from "./TaskNeedsYou";
import { ChangedFiles } from "./TaskChanges";
import TaskOutcome from "./TaskOutcome";
import { useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AlertCircle, Brain, Copy, Check, ChevronRight, Circle, FileText, ListChecks, MessageSquare, ShieldAlert, Terminal, UserRound, Wrench } from "lucide-react";
import { Collapsible } from "radix-ui";
import { AnimatePresence, motion } from "motion/react";
import { locale, t } from "../i18n";
import { useMedia } from "../state/hooks";
import type { AgentActivitySession, AgentTimelineEntry, DispatchSummary, TurnTiming } from "../types";
import { activityApprovals } from "../state/activity";
import { filePathParts, interactionKey } from "../state/activityModel";
import { timelineGroups, turnDuration } from "../state/timelineGroups";
import { Button, Icon, IconButton } from "./ui";
import { dispatchSourceLabel } from "./activity";
import { icons } from "../state/agents";
import { answerLabel, interactionSummary } from "../state/taskInteractions";
import { copyText } from "../platform";
import { processOpen, projectTurn, taskState, toolCounts, type ProcessRow } from "../state/taskProjection";
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
function Duration({ value }: { value?: number }) {
  return value === undefined ? null : <time>{durationText(value)}</time>;
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
          animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: [.34, 1.56, .64, 1] }}>
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
  return <article className="timeline-text timeline-user" aria-label={t("timeline.user")}>
    <div id={id} className="timeline-user-content">
      <div ref={content} className="timeline-user-preview" data-expanded={open || undefined} aria-hidden={open || undefined}>{text}</div>
      {open && <TimelineMarkdown text={text} />}
      {truncated && <span className="timeline-meta">{t("timeline.truncated")}</span>}
    </div>
    {overflow && <Button variant="ghost" className="timeline-user-toggle" aria-expanded={open} aria-controls={id} onClick={() => onChange(!open)}>
      {t(open ? "timeline.showLess" : "timeline.showMore")}
    </Button>}
  </article>;
}
function ToolTitle({ entry, project }: { entry: AgentTimelineEntry; project?: string | null }) {
  return <span className="timeline-entry-title mono" title={entry.command || entry.path || entry.title}>
    {entry.path && !entry.command ? <FilePath path={entry.path} project={project || entry.cwd} /> : entry.command || entry.title || t(entry.type === "command" ? "activity.phase.command" : entry.type === "file" ? "activity.phase.file" : "activity.phase.tool")}
  </span>;
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
  return <><IconButton icon={Copy} label={t("detail.copyReply")} onClick={() => void copyText(text).catch(() => setError(t("copyFailedSelectAndCopyTheTextManually")))} />{error && <span role="alert">{error}</span>}</>;
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
function ProcessEntry({ entry, agent, session }: { entry: AgentTimelineEntry; agent: string; session: AgentActivitySession }) {
  if (entry.type === "notice") return null;
  if (entry.type === "text") return <article className="task-phase"><span className="task-agent-mark" aria-label={agent}>{icons[agent] ? <span dangerouslySetInnerHTML={{ __html: icons[agent] }} /> : <Icon icon={MessageSquare} />}</span><TimelineMarkdown text={entry.text ?? ""} /></article>;
  if (entry.type === "user") return <div className="task-prompt">{entry.controlSource && <small>{t("detail.via", { source: dispatchSourceLabel(entry.controlSource) })}{entry.startedAt && ` · ${new Date(entry.startedAt).toLocaleTimeString(locale.get(), { hour: "2-digit", minute: "2-digit" })}`}</small>}<TimelineMarkdown text={entry.text ?? ""} /></div>;
  if (entry.type === "interaction") return <InteractionAnchor entry={entry} agent={agent} session={session} />;
  if (entry.type === "plan") return <section className="task-plan" aria-label={t("timeline.plan")}><strong>{t("timeline.plan")}</strong><ul>{entry.plan?.map((step, index) => <li key={index} data-state={step.status}>
    <Icon icon={step.status === "completed" ? Check : Circle} /><span>{step.content.text}</span>
  </li>)}</ul></section>;
  return <p className="timeline-error">{taskErrorText(entry.text || entry.title, "detail.failureUnknown")}</p>;
}
function ToolEntry({ entry, live }: { entry: AgentTimelineEntry; live: boolean }) {
  const [open, setOpen] = useState(false);
  const streaming = entry.type === "command" && live && entry.status === "running";
  const hasDetails = !!(entry.output?.text || entry.input?.text || entry.text || entry.cwd || entry.path || entry.changes?.length || entry.truncated || entry.input?.truncated || entry.output?.truncated);
  return <div className="task-tool-row" data-failed={entry.status === "failed" || undefined}>
    <Fold className="task-tool-entry" open={open} onChange={setOpen} expandable={hasDetails}
      summary={<><Icon icon={stepIcons[entry.type]} /><ToolTitle entry={entry} /><span>{entry.exitCode !== undefined && t("timeline.exitCode", { code: entry.exitCode })}</span></>}>
      {!!entry.changes?.length && <ChangedFiles entries={[entry]} />}
      <ToolDetails entry={entry} />
    </Fold>
    {streaming && !open && <pre className="task-live-log">{(entry.output?.text || entry.text || "").split("\n").slice(-8).join("\n")}</pre>}
  </div>;
}
function ToolRun({ entries, live }: { entries: AgentTimelineEntry[]; live: boolean }) {
  const active = live && entries.some(entry => entry.status === "running");
  const [manual, setManual] = useState<boolean>();
  const counts = toolCounts(entries, live);
  const stats = (Object.keys(counts) as (keyof typeof counts)[]).filter(kind => counts[kind] && (kind !== "running" || live)).map(kind => <span key={kind} className="task-tool-count">{t(`detail.tools.${kind}`, { count: counts[kind] })}</span>);
  return <Fold className="task-tool-run" open={manual ?? active} onChange={setManual} summary={<span className="task-tool-counts">{stats}</span>}>
    <div className="task-tool-rows">{entries.map(entry => <ToolEntry key={entry.id} entry={entry} live={live} />)}</div>
  </Fold>;
}
export default function TimelineEntries({ entries, agent, session, now, running = false, turnStatuses, turnTimings, status, onResume, onRetry, continuing }: {
  entries: AgentTimelineEntry[]; agent: string; session: AgentActivitySession; now: number; running?: boolean; turnDispatchSummaries?: Record<string, DispatchSummary>; turnStatuses?: Record<string, string>; status?: string; turnTimings?: Record<string, TurnTiming>;
  onResume?: () => void; onRetry?: () => void; continuing?: boolean;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const change = (id: string) => (open: boolean) => setExpanded(previous => ({ ...previous, [id]: open }));
  const groups = timelineGroups(entries);
  return <TimelineResources agent={agent} id={session.id}>{groups.map((group, index) => {
    const latest = index === groups.length - 1;
    const current = !session.turnId || !group.turnId || group.turnId === session.turnId;
    const live = latest && current && running;
    const pending = group.entries.some(entry => entry.type === "interaction" && entry.status === "pending");
    const state = taskState((group.turnId ? turnStatuses?.[group.turnId] : undefined) ?? (latest && current ? status : undefined), live, pending);
    const projection = projectTurn(group.entries, state);
    const { prompt, final, rows } = projection;
    const duration = turnDuration(group.entries, now, live, latest && current ? session.turnStartedAt : undefined, group.turnId ? turnTimings?.[group.turnId] : undefined);
    const source = prompt?.controlSource;
    const workId = `process:${group.id}:${state}`, turnOpen = latest || pending || (expanded[group.id] ?? false);
    const renderRow = (row: ProcessRow) => row.kind === "tools" ? <ToolRun key={row.id} entries={row.entries} live={live} /> : <ProcessEntry key={row.id} entry={row.entry} agent={agent} session={session} />;
    const process = <div className="task-process-rows">{rows.map(renderRow)}</div>;
    return <section className="task-turn" key={group.id} data-timeline-id={group.id}>
      {!latest && <Button variant="ghost" className="task-previous-turn" aria-expanded={turnOpen} onClick={() => change(group.id)(!turnOpen)}>
        <span>{t("detail.previousTurn", { turn: index + 1, count: projection.actions })}{duration !== undefined && ` · ${durationText(duration)}`}<span>{final?.text?.trim().split("\n")[0] || t("detail.noFinalReply")}</span></span><Icon icon={ChevronRight} className="timeline-chevron" />
      </Button>}
      {projection.answeredInteractions.map(entry => <InteractionAnchor key={entry.id} entry={entry} agent={agent} session={session} />)}
      {turnOpen && <div className="task-turn-content">
        {prompt && <div className="task-prompt">{source && <small>{t("detail.via", { source: dispatchSourceLabel(source) })}{prompt.startedAt && ` · ${new Date(prompt.startedAt).toLocaleTimeString(locale.get(), { hour: "2-digit", minute: "2-digit" })}`}</small>}
          <UserMessage text={prompt.text ?? ""} truncated={prompt.truncated} open={expanded[prompt.id] ?? false} onChange={change(prompt.id)} /></div>}
        {!!rows.length && (live ? process : <Fold className="task-process" open={processOpen(state, expanded[workId])} onChange={change(workId)} summary={<span>{t("detail.process", { updates: t("detail.process.updates", { count: projection.updates }), answers: t("detail.process.answers", { count: projection.answers }), actions: t("detail.process.actions", { count: projection.actions }) })}{duration !== undefined && <> · <Duration value={duration} /></>}</span>}>{process}</Fold>)}
        {(state === "failed" || state === "interrupted") && <TaskOutcome state={state} entries={group.entries} project={session.project} onResume={latest && current ? onResume : undefined} onRetry={latest && current ? onRetry : undefined} continuing={continuing} />}
        <TaskReceiptHistory agent={agent} id={session.id} turnId={group.turnId} latest={latest} />
        {projection.thinking && <div className="task-thinking" role="status">{projection.thinking.text}</div>}
        {final && state !== "failed" && state !== "interrupted" && <article className="task-final"><header><Icon icon={Check} /><strong>{t("detail.finalReply")}</strong><CopyReply text={final.text ?? ""} /></header><TimelineMarkdown text={final.text ?? ""} />{final.truncated && <span className="timeline-meta">{t("timeline.truncated")}</span>}<ChangedFiles entries={group.entries} project={session.project} /></article>}
      </div>}
    </section>;
  })}</TimelineResources>;
}
