import { usePanelState } from "./ui/Panel";
import { readOnlyBrowser } from "../browserMode";
import RelayRoute from "./RelayRoute";
import { dispatchSourceLabel, SourceBadge } from "./activity";
import RequestRouting from "./RequestRouting";
import { useRequestRouting } from "../state/requestRouting";
import { useEffect, useId, useRef, useState } from "react";
import { layers } from "../state/layers";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { AgentActivitySession, AgentTimelineEntry, DispatchSummary } from "../types";
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
export default function TaskNeedsYou({ agent, session, entries, source, narrow, inline = false }: {
  agent: string; session: AgentActivitySession; entries: AgentTimelineEntry[]; source?: DispatchSummary["controlSource"]; narrow: boolean; inline?: boolean;
}) {
  const submissions = activityApprovals.use();
  const [page, setPage] = useState(0);
  const [sheetOpen, setSheetOpen] = useState(false);
  const layerId = useId();
  const keepAfterWork = layers.use().find(layer => layer.id === layerId)?.keepAfterWork;
  const held = useRef<{ identity: string; question: boolean } | undefined>(undefined);
  const [drafts, setDrafts] = useState<Record<string, Record<string, string[]>>>({});
  const native = pendingSessions(agent, session, entries, submissions);
  const count = native.length;
  const index = Math.min(page, Math.max(0, count - 1));
  const pending = native[index];
  const identity = pending && interactionKey(agent, pending);
  if (sheetOpen && identity && !keepAfterWork) held.current = { identity, question: pending.interaction?.kind === "question" };
  const resolved = keepAfterWork && held.current && !native.some(request => interactionKey(agent, request) === held.current!.identity);
  const routing = useRequestRouting(agent, session.id, pending?.interaction);
  const pauseOnInteraction = (event: React.SyntheticEvent<HTMLElement>) => {
    if (readOnlyBrowser) return;
    const target = event.target as HTMLElement;
    if (event.type === "focus" && !target.matches("input, textarea, [contenteditable=true]")) return;
    if (target !== event.currentTarget && !target.closest("[data-routing-controls]")) void routing.change("pause");
  };
  const focus = useRef<HTMLElement>(null);
  useEffect(() => { if (identity && (!narrow || sheetOpen)) focus.current?.focus({ preventScroll: true }); }, [identity, narrow, sheetOpen]);
  useEffect(() => { if (!count && !keepAfterWork || !narrow) setSheetOpen(false); }, [count, narrow, keepAfterWork]);
  const interaction = pending?.interaction;
  usePanelState({ dirty: Object.values(drafts[identity ?? ""] ?? {}).some(values => values.some(value => value.length > 0)),
    busy: !!identity && submissions[identity]?.status === "submitting" || routing.busy });
  const route = (mode: "passive" | "actionable") => <RequestRouting mode={mode} routing={routing.error ? undefined : routing.routing} source={dispatchSourceLabel(source) || t("routing.source")} busy={routing.busy} change={routing.change} />;
  const passive = routing.routing && !["deferred", "paused"].includes(routing.routing.state) && !routing.error ? route("passive") : undefined;
  const dock = <section ref={focus} tabIndex={-1} className="task-needs-you" onFocusCapture={pauseOnInteraction} onPointerDownCapture={pauseOnInteraction} onClickCapture={pauseOnInteraction} onKeyDownCapture={pauseOnInteraction} onChangeCapture={pauseOnInteraction} aria-label={t("detail.needsYou")}>
    <header><RelayRoute source={source} agent={agent} reverse label={t("relay.request")} />{!narrow && passive}</header>
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
  if (inline && !narrow) return count ? <div className="relay-request">{dock}</div> : null;
  if (!narrow) return count ? <footer className="dialog-footer task-detail-footer">{dock}</footer> : null;
  return <>{count > 0 && <footer className="dialog-footer task-detail-footer" onFocusCapture={pauseOnInteraction} onPointerDownCapture={pauseOnInteraction} onClickCapture={pauseOnInteraction} onKeyDownCapture={pauseOnInteraction}>
    <RelayRoute source={source} agent={agent} reverse label={t("relay.request")} /><RequestEntry title={`${t("detail.needsYou")} · ${count}`} summary={interaction?.title || interaction?.summary} action={t("detail.openRequest")} onOpen={() => { if (!readOnlyBrowser) void routing.change("pause"); setSheetOpen(true); }} />
  </footer>}
    {sheetOpen && <Dialog layerId={layerId} dirty={!resolved && interaction?.kind === "question" && Object.values(drafts[identity!] ?? {}).some(values => values.some(value => value.length > 0))}
      busy={!resolved && (!!identity && submissions[identity]?.status === "submitting" || routing.busy)} title={t("detail.needsYou")} description={!resolved ? passive : undefined} onClose={() => setSheetOpen(false)} returnFocus=".request-entry button"><div className="task-input-sheet">{resolved ? <p role="status">{t("timeline.resolved")}</p> : dock}</div></Dialog>}
  </>;

}

export function TaskReceiptHistory({ agent, id, turnId, latest }: { agent: string; id: string; turnId?: string; latest: boolean }) {
  const { records } = tasks.use();
  const rows = taskReceipts(records, agent, id).filter(record => record.approval && ["approved", "bypass", "reject"].includes(record.approval.decision) && (record.turnId ? record.turnId === turnId : latest));
  return <>{rows.map(record => <div className="task-receipt-anchor" key={record.requestId}>
    <strong data-verdict={record.approval.decision}>{record.approval.answeredBy?.kind === "source" && <SourceBadge inline source={{ id: record.approval.answeredBy.sourceId, label: record.approval.answeredBy.label, kind: record.approval.answeredBy.brand }} />}{record.approval.decision === "approved" && record.approval.answeredBy && record.approval.answeredBy.kind !== "unknown" ? t("relay.approvedBy", { source: record.approval.answeredBy.kind === "local-ui" ? "ARC" : record.approval.answeredBy.label || record.approval.answeredBy.sourceId || "" }) : t(record.approval.decision === "approved" ? "detail.verdict.approved" : record.approval.decision === "bypass" ? "detail.verdict.bypass" : "detail.verdict.reject")}</strong><span>{record.task.title || record.task.prompt}</span>
  </div>)}</>;
}
