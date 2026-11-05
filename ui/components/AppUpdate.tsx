import { type ReactNode } from "react";
import { Popover } from "radix-ui";
import { ArrowUp, ExternalLink, LoaderCircle, X } from "lucide-react";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import { navigation } from "../state/navigation";
import { updates, available, updateVisible, checkUpdate, showUpdate, dismissUpdate, installUpdate, downloadUpdate, skipUpdate, updateActive } from "../state/updates";

import { Button, Notice, Progress, Icon, IconButton, Tooltip } from "./ui";
import { SettingsSection } from "./ui/Settings";
import { Card } from "./ui/card";
import "./AppUpdate.css";

const action = (promise: Promise<unknown>) => void promise.catch(error => notify(String(error), true));
function PanelContents() {
  const state = updates.use();
  const downloading = state.phase === "downloading";
  const installing = state.phase === "installing";
  return <>
    <header className="update-panel-header"><strong>{t("newVersionValue", { version: state.version ?? "—" })}</strong><IconButton icon={X} label={t("close")} onClick={dismissUpdate} /></header>
    <div className="update-panel-body">
      <Card asChild><section className="update-notes" tabIndex={0} aria-label={t("updates.notes")}><pre>{state.notes || t("updates.noNotes")}</pre></section></Card>
      {downloading && <div className="update-download"><Progress label={t("updateDownloadProgress")} value={state.total ? (state.downloaded ?? 0) / state.total * 100 : 0} /><p role="status">{t("downloadingValueMb", { size: ((state.downloaded ?? 0) / 1048576).toFixed(1) })}</p></div>}
      {state.error && <Notice>{state.error}</Notice>}
      {state.message && <p role="status">{state.message}</p>}
    </div>
    <footer className="update-panel-footer">
      {available() && <Button disabled={updateActive()} variant="ghost" onClick={skipUpdate}>{t("skipThisVersion")}</Button>}
      <span className="spacer" />
      {available() && !downloading && <Button variant="primary" busy={updateActive()} onClick={() => action(state.ready ? installUpdate() : downloadUpdate())}><span aria-live="polite">{t(installing ? "updates.installing" : state.ready ? "updates.restartNow" : "downloadUpdate")}</span></Button>}
    </footer>
  </>;
}
export function UpdateDock() {
  const state = updates.use();
  if (!updateVisible() && !state.panelOpen) return null;
  const active = updateActive();
  return <><span className="update-dock-divider" aria-hidden="true" /><Popover.Root modal={false} open={state.panelOpen} onOpenChange={open => open ? showUpdate() : dismissUpdate()}>
    <Popover.Trigger asChild><button type="button" className="update-dock-entry" data-hover-target="updates" aria-label={t("viewUpdate")}>
      <Icon icon={active ? LoaderCircle : ArrowUp} size={20} className={active ? "update-ring" : undefined} />{available() && <span className="update-available-dot" />}
    </button></Popover.Trigger>
    <Popover.Portal><Popover.Content className="update-panel" side="top" align="end" sideOffset={12} collisionPadding={16} aria-label={t("appUpdates")} onEscapeKeyDown={event => event.stopPropagation()}>
      <PanelContents />
    </Popover.Content></Popover.Portal>
  </Popover.Root></>;
}
export function AppUpdate({ children }: { children?: ReactNode }) {
  const { status } = connector.use(), state = updates.use();
  const checking = state.phase === 'checking';
  const feedback = state.error || state.message;
  const label = checking ? t('checkingLabel') : state.phase === 'downloading'
    ? t('downloadingValueMb', { size: ((state.downloaded ?? 0) / 1048576).toFixed(1) })
    : feedback ? state.error ? t('updateCheckRetry') : state.message : t('checkForUpdates');
  return <section className="settings-about">
    <SettingsSection title={t('aboutApp')}>
      <div className="update-summary">
        <p>Agent Remote Control v{status?.version ?? '—'}</p>
        {available() && <p className="update-version">{t('newVersionValue', { version: state.version })}</p>}
        <div className="actions">
          <Tooltip text={feedback || label}>
            <Button busy={checking} disabled={!isDesktop || updateActive()} onClick={() => action(checkUpdate())}>
              <span aria-live="polite">{label}</span>
            </Button>
          </Tooltip>
          {available() && <Button onClick={() => { navigation.set(old => ({ ...old, page: 'overview' })); showUpdate(); }}>{t('viewUpdate')}</Button>}
        </div>
      </div>
    </SettingsSection>
    <nav className="settings-about-links" aria-label={t('aboutApp')}>
      <span>whzxc/agent-remote-control</span>
      <Button variant="ghost" onClick={() => action(openUrl('https://github.com/whzxc/agent-remote-control'))}>GitHub <Icon icon={ExternalLink} /></Button>
      {children}
    </nav>
  </section>;
}
