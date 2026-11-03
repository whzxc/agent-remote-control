import { type ReactNode } from "react";
import { Popover } from "radix-ui";
import { ArrowUp, ExternalLink, LoaderCircle, X } from "lucide-react";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import { navigation } from "../state/navigation";
import { updates, available, updateVisible, checkUpdate, showUpdate, dismissUpdate, installUpdate, downloadUpdate, skipUpdate, cancelDownload } from "../state/updates";
import { updateActive } from "../state/updateModel";
import { Button, Group, Row, Notice, Progress, Icon, IconButton, Tooltip } from "./ui";
import "./AppUpdate.css";

const action = (promise: Promise<unknown>) => void promise.catch(error => notify(String(error), true));
function PanelContents() {
  const state = updates.use(), snapshot = state.snapshot, offer = snapshot.update;
  const downloading = snapshot.phase === "downloading";
  const installing = snapshot.phase === "installing";
  return <>
    <header className="update-panel-header"><strong>{t("newVersionValue", { version: offer?.version ?? "—" })}</strong><IconButton icon={X} label={t("close")} onClick={dismissUpdate} /></header>
    <div className="update-panel-body">
      <section className="update-notes" tabIndex={0} aria-label={t("updates.notes")}><pre>{offer?.notes || t("updates.noNotes")}</pre></section>
      {downloading && <div className="update-download"><Progress label={t("updateDownloadProgress")} value={snapshot.total ? (snapshot.downloaded ?? 0) / snapshot.total * 100 : 0} /><p role="status">{t("downloadingValueMb", { size: ((snapshot.downloaded ?? 0) / 1048576).toFixed(1) })}</p></div>}
      {offer?.ready && !installing && <p>{t("updates.restartHint")}</p>}
      {installing && <p role="status">{t("updates.installing")}</p>}
      {(state.error || snapshot.error) && <Notice>{state.error || snapshot.error}</Notice>}
      {state.message && <p role="status">{state.message}</p>}
    </div>
    <footer className="update-panel-footer">
      {available() && !updateActive(snapshot) && <Button variant="ghost" disabled={state.requesting} onClick={skipUpdate}>{t("skipThisVersion")}</Button>}
      {downloading && <Button onClick={() => action(cancelDownload())}>{t("cancelDownload")}</Button>}
      <span className="spacer" />
      {available() && !downloading && !installing && <Button variant="primary" busy={state.requesting} onClick={() => action(offer?.ready ? installUpdate() : downloadUpdate())}>{t(offer?.ready ? "updates.restartNow" : "downloadUpdate")}</Button>}
    </footer>
  </>;
}
export function UpdateDock() {
  const state = updates.use();
  if (!updateVisible() && !state.panelOpen) return null;
  const active = updateActive(state.snapshot);
  return <><span className="update-dock-divider" aria-hidden="true" /><Popover.Root modal={false} open={state.panelOpen} onOpenChange={open => open ? showUpdate() : dismissUpdate()}>
    <Popover.Trigger asChild><button type="button" className="update-dock-entry" data-hover-target="updates" aria-label={t("viewUpdate")}>
      <Icon icon={active ? LoaderCircle : ArrowUp} size={20} className={active ? "update-ring" : undefined} />{available() && <span className="update-available-dot" />}
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="update-panel" side="top" align="end" sideOffset={12} collisionPadding={16} aria-label={t("appUpdates")} onOpenAutoFocus={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      <PanelContents />
    </Popover.Content></Popover.Portal>
  </Popover.Root></>;
}
export function AppUpdate({ children }: { children?: ReactNode }) {
  const { status } = connector.use(), state = updates.use();
  const checking = state.snapshot.phase === 'checking';
  const feedback = state.error || state.message;
  const label = checking ? t('checkingLabel') : state.snapshot.phase === 'downloading'
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
    {available() && <Row title={t('newVersionValue', { version: state.snapshot.update?.version })}>
      <Button onClick={() => { navigation.set(old => ({ ...old, page: 'overview' })); showUpdate(); }}>{t('viewUpdate')}</Button>
    </Row>}
    <Row title="whzxc/agent-remote-control">
      <Button variant="ghost" onClick={() => action(openUrl('https://github.com/whzxc/agent-remote-control'))}>GitHub <Icon icon={ExternalLink} /></Button>
    </Row>
    {children}
  </Group>;
}
