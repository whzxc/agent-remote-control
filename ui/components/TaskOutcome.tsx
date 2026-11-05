import { useState, type ReactNode } from "react";
import type { AgentTimelineEntry } from "../types";
import { locale, t } from "../i18n";
import { copyText } from "../platform";
import { changedFiles } from "../state/taskProjection";
import { taskErrorText } from "../state/taskErrors";
import { Button, Icon } from "./ui";
import { AlertCircle } from "lucide-react";
import { TaskCard } from "./ui/TaskPresentation";
import { ChangedFiles } from "./TaskChanges";

export default function TaskOutcome({ state, entries, project, onResume, onRetry, continuing, failedTools }: { failedTools?: ReactNode; state: "failed" | "interrupted"; entries: AgentTimelineEntry[]; project?: string | null; onResume?: () => void; onRetry?: () => void; continuing?: boolean }) {
  const [diff, setDiff] = useState(false), [error, setError] = useState("");
  const failure = [...entries].reverse().find(entry => entry.type === "error" || entry.status === "failed");
  const log = [failure?.command, failure?.cwd, failure?.text, failure?.output?.text].filter(Boolean).join("\n");
  const changes = changedFiles(entries);
  const diffs = entries.flatMap(entry => entry.status === "completed" ? entry.changes?.filter(change => change.diff?.text) ?? [] : []);
  const ended = [...entries].reverse().find(entry => entry.endedAt)?.endedAt;
  return <>
    {state === "interrupted" && <div className="task-stop-divider">{t("detail.stoppedUnknown")}{ended && ` · ${new Date(ended).toLocaleTimeString(locale.get(), { hour: "2-digit", minute: "2-digit" })}`}</div>}
    <TaskCard reply role="article" className="task-outcome" data-state={state} aria-label={t(state === "failed" ? "detail.turnFailed" : "detail.leftAsIs")}>
      <header><strong>{state === "failed" && <Icon icon={AlertCircle} size={18} />}{t(state === "failed" ? "detail.turnFailed" : "detail.leftAsIs")}</strong>{failedTools}</header>
      {state === "failed" && <><p>{taskErrorText(failure?.text || failure?.output?.text, "detail.failureUnknown")}</p>{(failure?.command || failure?.cwd || failure?.path) && <pre>{[failure.command, failure.cwd, failure.path].filter(Boolean).join("\n")}</pre>}</>}
      <p>{t(changes.length ? "detail.recordedChanges" : "detail.changesUnknown")}</p>
      <ChangedFiles entries={entries} project={project} />
      <div className="actions">
      {state === "interrupted" && onResume && <Button variant="secondary" disabled={continuing} busy={continuing} onClick={onResume}>{t("detail.resumeInterrupted")}</Button>}
      {state === "failed" && onRetry && <Button variant="secondary" disabled={continuing} busy={continuing} onClick={onRetry}>{t("detail.retry")}</Button>}
      {state === "failed" ? <Button variant="ghost" disabled={continuing || !log} onClick={() => void copyText(log).catch(() => setError(t("copyFailedSelectAndCopyTheTextManually")))}>{t("detail.copyLog")}</Button>
        : <Button variant="secondary" disabled={continuing || !diffs.length} aria-expanded={diff} onClick={() => setDiff(!diff)}>{t("detail.viewDiff")}</Button>}</div>
      {diff && diffs.map((change, index) => <section key={index}><strong>{change.path}</strong><pre>{change.diff?.text}</pre>{change.diff?.truncated && <small>{t("timeline.truncated")}</small>}</section>)}
      {error && <p role="alert">{error}</p>}
    </TaskCard>
  </>;
}
