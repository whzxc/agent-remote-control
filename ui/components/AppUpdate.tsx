import { TransientLayer } from "./ui/TransientLayer";
import { useEffect, useState, type ReactNode } from "react";
import { Popover } from "radix-ui";
import { ArrowUp, ArrowUpRight, ChevronRight, Ellipsis, ExternalLink, LoaderCircle, RefreshCw, RotateCw } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { locale, t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import { navigation } from "../state/navigation";
import { groupedReleaseNotes, releaseList, updateRange, type PublishedRelease } from "../state/releaseNotes";
import {
  updates, available, updateVisible, checkUpdate, showUpdate, dismissUpdate,
  installUpdate, downloadUpdate, skipUpdate, updateActive, loadReleaseHistory,
} from "../state/updates";
import Dialog from "./ui/Dialog";
import { Button, Notice, Progress, Icon, IconButton, Menu, Tooltip } from "./ui";
import { SettingsSection, Setting } from "./ui/Settings";
import { Card } from "./ui/card";
import "./AppUpdate.css";

const repository = "https://github.com/whzxc/agent-remote-control";
const action = (promise: Promise<unknown>) => void promise.catch(error => notify(String(error), true));
const mb = (bytes: number) => (bytes / 1048576).toFixed(1);

function ReleaseMarkdown({ text, inline = false }: { text: string; inline?: boolean }) {
  return <ReactMarkdown skipHtml disallowedElements={["img"]} components={{
    ...(inline ? { p: ({ children }) => <>{children}</> } : {}),
    a: ({ href, children }) => href?.startsWith("https://")
      ? <a href={href} onClick={event => { event.preventDefault(); action(openUrl(href)); }}>{children}</a>
      : <span>{children}</span>,
  }}>{text}</ReactMarkdown>;
}

function ReleaseGroups({ releases, history = false }: { releases: PublishedRelease[]; history?: boolean }) {
  const language = locale.use();
  const groups = groupedReleaseNotes(releases, language);
  const Heading = history ? "h4" : "h3";
  const showVersions = releases.length > 1;
  if (!groups.length) return <p>{t("updates.noNotes")}</p>;
  return groups.map(group => {
    const bullets = group.entries.flatMap(({ markdown, version }) => markdown.split(/\r?\n/)
      .filter(line => line.trim())
      .map(line => ({ version, text: /^[-*+] (.+)$/.exec(line)?.[1] })));
    return <section key={group.title} className="update-note-group">
      <Heading>{group.title}</Heading>
      {bullets.every(bullet => bullet.text) ? <ul>{bullets.map(({ text, version }, index) => (
        <li key={index}><ReleaseMarkdown inline text={text!} />
          {showVersions && <span className="update-note-version">{version}</span>}
        </li>
      ))}</ul> : group.entries.map(({ version, markdown }) => <div key={`${version}:${markdown}`} className="update-note-entry">
        {showVersions && <p className="update-note-version">{version}</p>}
        <ReleaseMarkdown text={markdown} />
      </div>)}
    </section>;
  });
}

function PanelContents() {
  const state = updates.use();
  const { status } = connector.use();
  const [history, setHistory] = useState<PublishedRelease[]>([]);
  useEffect(() => {
    if (!state.panelOpen || !state.version) return;
    let current = true;
    void loadReleaseHistory().then(rows => { if (current) setHistory(rows); }, () => {});
    return () => { current = false; };
  }, [state.panelOpen, state.version]);

  const downloading = state.phase === "downloading";
  const installing = state.phase === "installing";
  const checking = state.phase === "checking";
  const currentVersion = state.currentVersion ?? status?.version;
  const releaseStatus = downloading ? t("updates.downloading") : state.ready && !installing ? t("updates.ready") : "";
  const metadata = [currentVersion && t("updates.currentVersion", { version: currentVersion }), releaseStatus].filter(Boolean).join(" · ");
  const notes = state.notesZh ? `${state.notes ?? ""}\n\n<!-- lang:zh-CN -->\n\n${state.notesZh}` : state.notes ?? "";
  const releases = state.version ? updateRange(history, currentVersion, { version: state.version, notes }) : [];
  const errorLabel = state.version ? state.ready ? "updates.installFailed" : "updates.downloadFailed" : "updates.checkFailed";
  const primaryLabel = installing ? "updates.installing" : state.ready
    ? state.error ? "updates.retryInstall" : "updates.restartNow"
    : state.error ? "updates.retryDownload" : "downloadUpdate";
  return <>
    <header className="update-panel-header">
      <h2>{state.version ? t("updates.targetVersion", { version: state.version }) : t("appUpdates")}</h2>
    </header>
    <div className="update-panel-body">
      {(metadata || downloading) && <div className="update-download">
        <div className="update-status" role="status">
          <span>{metadata}</span>
          {downloading && <span>{state.total ? `${mb(state.downloaded)} / ${mb(state.total)} MB` : `${mb(state.downloaded)} MB`}</span>}
        </div>
        {downloading && !!state.total && <Progress label={t("updateDownloadProgress")}
          value={state.downloaded / state.total * 100} />}
      </div>}
      {state.error && <Notice><span title={state.error}>{t(errorLabel)}</span></Notice>}
      {state.version && <Card asChild padded>
        <section className="update-notes" tabIndex={0} aria-label={t("updates.notes")}>
          <ReleaseGroups releases={releases} />
        </section>
      </Card>}
      {(checking || state.message) && <p role="status">{checking ? t("checkingLabel") : state.message}</p>}
    </div>
    <footer className="update-panel-footer">
      {state.ready && <p>{t("updates.restartEffect")}</p>}
      <div className="update-actions">
        <Button disabled={installing} variant="ghost" onClick={dismissUpdate}>{t(state.version ? "updates.later" : "close")}</Button>
        {available() && !downloading && <Button variant="primary" busy={updateActive()}
          onClick={() => action(state.ready ? installUpdate(state.version) : downloadUpdate())}>
          {!installing && <Icon icon={state.ready ? RotateCw : RefreshCw} />}
          <span aria-live="polite">{t(primaryLabel)}</span>
        </Button>}
        {!state.version && state.error && <Button variant="primary" onClick={() => action(checkUpdate())}>{t("updateCheckRetry")}</Button>}
      </div>
    </footer>
  </>;
}

export function UpdateDock() {
  const state = updates.use();
  if (!updateVisible() && !state.panelOpen) return null;
  const active = updateActive();
  const installing = state.phase === "installing";
  return <><span className="update-dock-divider" aria-hidden="true" /><Popover.Root modal={false} open={state.panelOpen}
    onOpenChange={open => { if (!installing) open ? showUpdate() : dismissUpdate(); }}>
    <Popover.Trigger asChild><button type="button" className="update-dock-entry" data-hover-target="updates" aria-label={t("viewUpdate")}>
      <Icon icon={active ? LoaderCircle : ArrowUp} size={20} className={active ? "update-ring" : undefined} />{available() && <span className="update-available-dot" />}
    </button></Popover.Trigger>
    <Popover.Portal><TransientLayer><Popover.Content className="update-panel" side="top" align="end" sideOffset={12} collisionPadding={16}
      aria-label={t("appUpdates")} onEscapeKeyDown={event => { event.stopPropagation(); if (installing) event.preventDefault(); }}>
      <PanelContents />
    </Popover.Content></TransientLayer></Popover.Portal>
  </Popover.Root></>;
}

function UpdateHistory({ currentVersion, onClose }: { currentVersion?: string; onClose: () => void }) {
  const [request, setRequest] = useState(0);
  const [releases, setReleases] = useState<PublishedRelease[]>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    void loadReleaseHistory().then(rows => { if (current) setReleases(releaseList(rows, currentVersion)); },
      () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [currentVersion, request]);
  const retry = () => { setFailed(false); setRequest(previous => previous + 1); };
  return <Dialog size="m" title={t("updates.history")} className="update-history" onClose={onClose}>
    {failed ? <Notice action={<Button onClick={retry}>{t("retry")}</Button>}>{t("updates.historyFailed")}</Notice>
      : !releases ? <p role="status">{t("updates.historyLoading")}</p>
      : !releases.length ? <p>{t("updates.noNotes")}</p>
      : <div className="update-history-list" tabIndex={0} role="region" aria-label={t("updates.history")}>
        {releases.map(release => <Card key={release.version} padded className="update-history-release">
          <h3>{release.version}</h3>
          <ReleaseGroups releases={[release]} history />
        </Card>)}
      </div>}
    <div className="update-history-link">
      <Button variant="link" onClick={() => action(openUrl(`${repository}/releases`))}>
        {t("updates.allReleases")} <Icon icon={ArrowUpRight} size={14} />
      </Button>
    </div>
  </Dialog>;
}

export function AppUpdate({ children }: { children?: ReactNode }) {
  const { status } = connector.use(), state = updates.use();
  const [historyOpen, setHistoryOpen] = useState(false);
  const currentVersion = state.currentVersion ?? status?.version;
  const checking = state.phase === "checking";
  const feedback = state.error || state.message;
  const label = checking ? t("checkingLabel") : state.phase === "downloading"
    ? t("downloadingValueMb", { size: mb(state.downloaded) })
    : feedback ? state.error ? t("updateCheckRetry") : state.message : t("checkForUpdates");
  return <section className="settings-about">
    <SettingsSection title={t("aboutApp")}>
      <Setting title={`ARC ${currentVersion ?? "—"}`} width={available() ? 300 : 152}>
        <div className="actions">
          <Tooltip text={feedback || label}>
            <Button busy={checking} disabled={!isDesktop || updateActive()} onClick={() => action(checkUpdate())}>
              <span aria-live="polite">{label}</span>
            </Button>
          </Tooltip>
          {available() && <>
            <Button onClick={() => { navigation.set(old => ({ ...old, page: "overview" })); showUpdate(); }}>{t("viewUpdate")}</Button>
            <Menu label={t("appUpdates")} trigger={<IconButton icon={Ellipsis} label={t("appUpdates")} />}
              items={[{ label: t("skipThisVersion"), action: skipUpdate, disabled: updateActive() }]} />
          </>}
        </div>
      </Setting>
      <Setting title={t("updates.history")} width={34}>
        <IconButton icon={ChevronRight} label={t("updates.history")} onClick={() => setHistoryOpen(true)} />
      </Setting>
    </SettingsSection>
    <nav className="settings-about-links" aria-label={t("aboutApp")}>
      <span>whzxc/agent-remote-control</span>
      <Button variant="ghost" onClick={() => action(openUrl(repository))}>GitHub <Icon icon={ExternalLink} size={14} /></Button>
      {children}
    </nav>
    {historyOpen && <UpdateHistory currentVersion={currentVersion} onClose={() => setHistoryOpen(false)} />}
  </section>;
}
