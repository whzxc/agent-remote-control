import { readOnlyBrowser } from "../browserMode";
import RequestRouting from "./RequestRouting";
import { useRequestRouting } from "../state/requestRouting";
import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AgentActivitySession, AgentTimelineEntry } from "../types";
import { t } from "../i18n";
import { activityApprovals } from "../state/activity";
import { interactionKey } from "../state/activityModel";
import { pendingSessions } from "../state/taskInteractions";
import { tasks, type TaskRecord } from "../state/tasks";
import ActivityInteraction from "./ActivityInteraction";
import TaskQuestion from "./TaskQuestion";
import { Dialog, IconButton } from "./ui";
import { TaskCard, RequestEntry } from "./ui/TaskPresentation";

export function taskReceipts(records: TaskRecord[], agent: string, id: string) {
  return records.filter(record => (record.agent || "codex") === agent && (record.taskId || record.threadId || record.task.threadId) === id);
}
export default function TaskNeedsYou({ agent, session, entries, source, narrow }: {
  agent: string; session: AgentActivitySession; entries: AgentTimelineEntry[]; source?: string; narrow: boolean;
}) {
  const submissions = activityApprovals.use();
  const [page, setPage] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string[]>>>({});
  const native = pendingSessions(agent, session, entries, submissions);
  const count = native.length;
  const index = Math.min(page, Math.max(0, count - 1));
  const pending = native[index];
  const identity = pending && interactionKey(agent, pending);
  const routing = useRequestRouting(agent, session.id, pending?.interaction);
  const pauseOnInteraction = (event: React.SyntheticEvent<HTMLElement>) => {
    if (readOnlyBrowser) return;
    const target = event.target as HTMLElement;
    if (event.type === "focus" && !target.matches("input, textarea, [contenteditable=true]")) return;
    if (target !== event.currentTarget && !target.closest("[data-routing-controls]")) void routing.change("pause");
  };
  const focus = useRef<HTMLElement>(null);
  useEffect(() => { if (identity && (!narrow || sheetOpen)) focus.current?.focus({ preventScroll: true }); }, [identity, narrow, sheetOpen]);
  useEffect(() => { if (!count || !narrow) setSheetOpen(false); }, [count, narrow]);
  if (!count) return null;
  const interaction = pending?.interaction;
  const route = (mode: "passive" | "actionable") => <RequestRouting mode={mode} routing={routing.error ? undefined : routing.routing} source={source || t("routing.source")} busy={routing.busy} change={routing.change} />;
  const passive = routing.routing && !["deferred", "paused"].includes(routing.routing.state) && !routing.error ? route("passive") : undefined;
  const actionable = routing.routing && ["deferred", "paused"].includes(routing.routing.state);
  const dock = <section ref={focus} tabIndex={-1} className="task-needs-you" onFocusCapture={pauseOnInteraction} onPointerDownCapture={pauseOnInteraction} onClickCapture={pauseOnInteraction} onKeyDownCapture={pauseOnInteraction} onChangeCapture={pauseOnInteraction} aria-label={t("detail.needsYou")}>
    {!narrow && <header><strong>{t("detail.needsYou")}</strong>{passive}</header>}
    {count > 1 && <nav className="actions" aria-label={t("detail.needsYou")}><IconButton compact icon={ChevronLeft} label={t("detail.previousRequest")} disabled={index === 0} onClick={() => setPage(index - 1)} /><span>{t("detail.pager", { current: index + 1, total: count })}</span><IconButton compact icon={ChevronRight} label={t("detail.nextRequest")} disabled={index === count - 1} onClick={() => setPage(index + 1)} /></nav>}
    {pending && interaction && <TaskCard className="task-request-card">
      {interaction.kind === "question" ? <TaskQuestion key={identity} agent={agent} session={pending} answers={drafts[identity!] ?? {}} onAnswersChange={answers => setDrafts(old => ({ ...old, [identity!]: answers }))} routing={route("actionable")} /> : <>
        <div className="task-request-preview"><header><strong>{interaction.title || interaction.summary}</strong><span>{t("timeline.allowOnce")}</span></header>
          {(interaction.command || interaction.preview || interaction.path) && <pre>{interaction.command || interaction.preview || interaction.path}</pre>}
          {interaction.cwd && <div className="mono">{t("timeline.cwd")} · {interaction.cwd}</div>}
          {interaction.reason && <p>{interaction.reason}</p>}
        </div>
        <ActivityInteraction key={identity} agent={agent} session={pending} routing={route("actionable")} />
      </>}
    </TaskCard>}
  </section>;
  if (!narrow) return <footer className="dialog-footer task-detail-footer">{dock}</footer>;
  return <><footer className="dialog-footer task-detail-footer" onFocusCapture={pauseOnInteraction} onPointerDownCapture={pauseOnInteraction} onClickCapture={pauseOnInteraction} onKeyDownCapture={pauseOnInteraction}>
    <RequestEntry title={`${t("detail.needsYou")} · ${count}`} summary={interaction?.title || interaction?.summary} action={t("detail.openRequest")} onOpen={() => { if (!readOnlyBrowser) void routing.change("pause"); setSheetOpen(true); }} />
  </footer>
    {sheetOpen && <Dialog sheet width={actionable ? 392 : 360} title={t("detail.needsYou")} description={passive} onClose={() => setSheetOpen(false)} returnFocus=".request-entry button"><div className="task-input-sheet">{dock}</div></Dialog>}
  </>;

}

export function TaskReceiptHistory({ agent, id, turnId, latest }: { agent: string; id: string; turnId?: string; latest: boolean }) {
  const { records } = tasks.use();
  const rows = taskReceipts(records, agent, id).filter(record => record.approval && ["approved", "bypass", "reject"].includes(record.approval.decision) && (record.turnId ? record.turnId === turnId : latest));
  return <>{rows.map(record => <div className="task-receipt-anchor" key={record.requestId}>
    <strong data-verdict={record.approval.decision}>{t(record.approval.decision === "approved" ? "detail.verdict.approved" : record.approval.decision === "bypass" ? "detail.verdict.bypass" : "detail.verdict.reject")}</strong><span>{record.task.title || record.task.prompt}</span><small>{record.approval.source === "local" ? t("detail.byARC") : record.origin?.sourceLabel || record.approval.source}</small>
  </div>)}</>;
}
