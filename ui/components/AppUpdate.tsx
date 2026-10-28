import { useState } from "react";
import { Popover } from "radix-ui";
import { ArrowUp, Check, ExternalLink, LoaderCircle, X } from "lucide-react";
import { t } from "../i18n";
import { copyText, isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import { navigation } from "../state/navigation";
import { agentActivity } from "../state/activity";
import { useInterval } from "../state/hooks";
import { updates, available, updateVisible, checkUpdate, showUpdate, dismissUpdate, installUpdate, scheduleUpdate, skipUpdate, cancelDownload, dismissOutcome, retryUpdate, openReleaseNotes } from "../state/updates";
import { updateActive, updateCountdown, updateStep, type UpdateSnapshot, type UpdateTiming, type UpdateWork } from "../state/updateModel";
import { Button, Group, Row, Notice, Progress, Icon, IconButton, SingleChoice, Tooltip } from "./ui";
import TaskQuestion from "./TaskQuestion";
import ActivityInteraction from "./ActivityInteraction";
import "./AppUpdate.css";

const action = (promise: Promise<unknown>) => void promise.catch(error => notify(String(error), true));
async function reveal(path: string) {
  if (isDesktop) { const { revealItemInDir } = await import("@tauri-apps/plugin-opener"); await revealItemInDir(path); }
}
function Identity({ job }: { job: UpdateSnapshot }) {
  return <><strong>{t(job.source?.kind === "local" ? "updates.localVersion" : "updates.releaseVersion", { version: job.source?.version ?? "—" })}</strong>
    {job.source?.kind === "local" && job.source.build && <code>{job.source.branch ? `${job.source.branch} @ ` : ""}{job.source.build.slice(0, 8)}</code>}
    {!!job.source?.landedLanes?.length && <span>{job.source.landedLanes.join(", ")}</span>}</>;
}
function WorkItem({ item, answerable }: { item: UpdateWork; answerable: boolean }) {
  const activity = agentActivity.use().snapshot;
  const session = item.agent ? activity?.agents[item.agent]?.sessions.find(session => session.id === item.taskId) : undefined;
  const [answers, setAnswers] = useState<Record<string, string[]>>({});
  return <li>
    <div className="update-work-title"><span>{item.title || session?.title || item.taskId || t(`updates.work.${item.kind}`)}</span>{item.count !== undefined && <span>{item.count}</span>}</div>
    {answerable && session?.interaction && (session.interaction.kind === "question"
      ? <TaskQuestion key={JSON.stringify(session.interaction.respond)} agent={item.agent!} session={session} answers={answers} onAnswersChange={setAnswers} />
      : <ActivityInteraction agent={item.agent!} session={session} />)}
  </li>;
}
function WorkGroups({ job }: { job: UpdateSnapshot }) {
  return <>{(["blocking", "willResume", "unaffected", "stale"] as const).map(group => {
    const items = job.work[group] ?? [];
    if (group === "stale" && !items.length) return null;
    return <section key={group} className="update-work-group" aria-label={t(`updates.${group}`)}>
      <h3>{t(`updates.${group}`)} <span>{items.length}</span></h3>
      {!!items.length && <ul>{items.map((item, index) => <WorkItem key={`${item.agent}:${item.taskId}:${index}`} item={item} answerable={group === "blocking"} />)}</ul>}
    </section>;
  })}</>;
}
function Steps({ job }: { job: UpdateSnapshot }) {
  const step = updateStep(job);
  return <ol className="update-steps" aria-label={t("updates.progress")}>
    {["verify", "backup", "settle", "restart", "health", "resume"].map((name, index) => <li key={name} data-complete={index < step || undefined} aria-current={index === step ? "step" : undefined}>
      <span>{index < step ? <Icon icon={Check} /> : index + 1}</span>{t(`updates.step.${name}`)}
    </li>)}
  </ol>;
}
function PanelContents() {
  const s = updates.use(), job = s.snapshot;
  const [selection, setSelection] = useState<UpdateTiming | undefined>();
  const timing = job.supported === false ? "now" : selection ?? job.when;
  const [clock, setClock] = useState(Date.now());
  useInterval(() => setClock(Date.now()), 250);
  const seconds = updateCountdown(job, clock);
  const advancing = ["countdown", "swapping", "starting", "verifying", "resuming", "rolling-back"].includes(job.state);
  const canSchedule = !!job.id && job.canSchedule !== false && ["settling", "countdown", "verifying"].includes(job.state);
  const downloading = job.state === "downloading";
  const primary = () => available() ? installUpdate(timing) : scheduleUpdate(timing === "now" ? "now" : "defer", timing === "settled" ? 1 : undefined);
  return <>
    <header className="update-panel-header"><div><Identity job={job} /></div><IconButton icon={X} label={t("close")} onClick={dismissUpdate} /></header>
    <div className="update-panel-body">
    {advancing ? <div className="update-countdown" role="status" aria-live="polite">
      <h2>{seconds === undefined ? t(`updates.state.${job.state}`) : t("replacementCountdown", { seconds })}</h2>
      <Steps job={job} />
    </div> : <div className="update-columns">
      <section className="update-notes" tabIndex={0} aria-label={t(job.source?.kind === "local" ? "updates.localNotes" : "updates.notes")}><h3>{t(job.source?.kind === "local" ? "updates.localNotes" : "updates.notes")}</h3><pre>{job.notes || t("updates.noNotes")}</pre>
        {downloading && <><Progress label={t("updateDownloadProgress")} value={job.total ? (job.downloaded ?? 0) / job.total * 100 : 0} /><p role="status">{t("downloadingValueMb", { size: ((job.downloaded ?? 0) / 1048576).toFixed(1) })}</p></>}
        {job.state === "checking" && <p role="status">{t("checkingLabel")}</p>}
      </section>
      <section className="update-impact" tabIndex={0}><WorkGroups job={job} />
        <SingleChoice label={t("updates.timing")} value={timing} onChange={value => setSelection(value as UpdateTiming)} disabled={job.supported === false || s.requesting || !available() && !canSchedule} options={(["settled", "now", "defer"] as const).map(value => ({ value, label: t(`updates.when.${value}`) }))} />
        {job.supported === false && <p>{t("updates.pipelineUnsupported")}</p>}
        {timing === "now" && job.work.blocking.length > 0 && <p className="update-consequence">{t("updates.dropInteractions")}</p>}
        {job.when === "defer" && job.deferUntil && <time dateTime={job.deferUntil}>{t("updates.deferredUntil", { time: new Date(job.deferUntil).toLocaleTimeString() })}</time>}
      </section>
    </div>}
    {(s.error || job.error) && <Notice>{s.error || job.error}</Notice>}
    {s.message && <p role="status">{s.message}</p>}
    </div>
    <footer className="update-panel-footer">
      {available() && <Button variant="ghost" disabled={s.requesting} onClick={skipUpdate}>{t("skipThisVersion")}</Button>}
      {canSchedule && <Button variant="ghost" disabled={s.requesting} onClick={() => action(scheduleUpdate("cancel"))}>{t(job.source?.kind === "local" ? "updates.cancelReplacement" : "cancel")}</Button>}
      {downloading && <Button disabled={s.requesting} onClick={() => action(cancelDownload())}>{t("cancelDownload")}</Button>}
      <span className="spacer" />
      {job.state === "idle" && <Button disabled={s.requesting} onClick={() => action(checkUpdate())}>{t("checkForUpdates")}</Button>}
      {(available() || canSchedule) && <Button variant="primary" busy={s.requesting} onClick={() => action(advancing ? scheduleUpdate("now") : primary())}>{t(advancing ? "updates.restartNow" : `updates.action.${timing}`)}</Button>}
    </footer>
  </>;
}
export function UpdateDock() {
  const s = updates.use();
  if (!updateVisible() && !s.panelOpen) return null;
  const settling = updateActive(s.snapshot);
  return <><span className="update-dock-divider" aria-hidden="true" /><Popover.Root modal={false} open={s.panelOpen} onOpenChange={open => open ? showUpdate() : dismissUpdate()}>
    <Popover.Trigger asChild><button type="button" className="update-dock-entry" data-hover-target="updates" aria-label={t("viewUpdate")}>
      <Icon icon={settling ? LoaderCircle : ArrowUp} size={20} className={settling ? "update-ring" : undefined} />{available() && <span className="update-available-dot" />}
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="update-panel" side="top" align="end" sideOffset={12} collisionPadding={16} aria-label={t("appUpdates")} onOpenAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      <PanelContents key={s.snapshot.id ?? s.snapshot.source?.version ?? "offer"} />
    </Popover.Content></Popover.Portal>
  </Popover.Root></>;
}
export function UpdateOutcome() {
  const { outcome: job } = updates.use();
  if (!job) return null;
  const failedRestore = job.state === "failed" && job.backupMoved;
  const title = failedRestore ? "updates.restoreFailed" : job.state === "succeeded" && job.source?.kind === "local" ? "updates.localReplaced" : `updates.state.${job.state}`;
  return <aside className="update-outcome" role="status" aria-live="polite">
    <header><strong>{t(title)}</strong><IconButton icon={X} label={t("dismissMessage")} onClick={dismissOutcome} /></header>
    {job.error && <p>{job.error}</p>}
    {failedRestore && <code>{job.backup}</code>}
    <div className="actions">
      {job.state === "succeeded" && <><Button onClick={() => action(openReleaseNotes())}>{t("updates.notes")}</Button><Button onClick={() => { navigation.set(old => ({ ...old, page: "overview" })); dismissOutcome(); }}>{t("updates.resumedTasks", { count: job.resumedCount ?? 0 })}</Button></>}
      {job.state === "rolled-back" && <><Button disabled={!job.logPath} onClick={() => job.logPath && action(reveal(job.logPath))}>{t("updates.viewLog")}</Button><Button onClick={() => { action(retryUpdate(job)); dismissOutcome(); }}>{t("retryReplacement")}</Button></>}
      {failedRestore && job.backup && <><Button onClick={() => action(reveal(job.backup!))}>{t("updates.showInFinder")}</Button><Button onClick={() => action(copyText(job.backup!))}>{t("updates.copyPath")}</Button></>}
      {job.state === "failed" && !failedRestore && <Button onClick={() => { action(retryUpdate(job)); dismissOutcome(); }}>{t("retryReplacement")}</Button>}
    </div>
  </aside>;
}
export function AppUpdate() {
  const { status } = connector.use(), state = updates.use();
  const checking = state.snapshot.state === 'checking';
  const feedback = state.error || state.message;
  const label = checking ? t('checkingLabel') : state.snapshot.state === 'downloading'
    ? t('downloadingValueMb', { size: ((state.snapshot.downloaded ?? 0) / 1048576).toFixed(1) })
    : feedback ? state.error ? t('updateCheckRetry') : state.message : t('checkForUpdates');
  return <Group title={t('aboutApp')}>
    <Row title={`Agent Remote Control v${status?.version ?? '—'}`}>
      <Tooltip text={feedback || label}>
        <Button className="update-check" aria-busy={checking}
          disabled={!isDesktop || state.requesting || updateActive(state.snapshot)} onClick={() => action(checkUpdate())}>
          {[t('checkForUpdates'), t('youAreUpToDate'), t('updateCheckRetry')].map(text => <span key={text} className="update-check-size" aria-hidden="true">{text}</span>)}
          <span className="update-check-label" aria-live="polite">{label}</span>
        </Button>
      </Tooltip>
    </Row>
    {available() && <Row title={t('newVersionValue', { version: state.snapshot.source?.version })}>
      <Button onClick={() => { navigation.set(old => ({ ...old, page: 'overview' })); showUpdate(); }}>{t('viewUpdate')}</Button>
    </Row>}
    <Row title="whzxc/agent-remote-control">
      <Button variant="ghost" onClick={() => action(openUrl('https://github.com/whzxc/agent-remote-control'))}>GitHub <Icon icon={ExternalLink} /></Button>
    </Row>
  </Group>;
}
