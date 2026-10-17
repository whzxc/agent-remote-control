import { ExternalLink } from "lucide-react";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import {
  updates,
  available,
  updateVisible,
  checkUpdate,
  showUpdate,
  dismissUpdate,
  installUpdate,
  cancelUpdate,
  skipUpdate,
  openDownloads,
} from "../state/updates";
import {
  Button,
  Dialog,
  Group,
  Row,
  Notice,
  Progress,
  Icon,
} from "./ui";
import { displayMessage } from "../messages";
export function AppUpdate() {
  const { status } = connector.use(),
    state = updates.use(),
    checking = state.checking,
    active = state.phase !== "idle";
  return (
    <Group title={t("aboutApp")}>
      <Row title={`Agent Remote Control v${status?.version ?? "—"}`}>
        <Button
          busy={checking}
          disabled={!isDesktop || active}
          onClick={() => void checkUpdate()}
        >
          {t("checkForUpdates")}
        </Button>
      </Row>
      {updateVisible() && (
        <Row title={t("newVersionValue", { version: state.update?.version })}>
          <Button onClick={showUpdate}>{t("viewUpdate")}</Button>
        </Row>
      )}
      {!state.dialogOpen && state.error && (
        <Notice>{displayMessage(state.error)}</Notice>
      )}
      {!state.dialogOpen && state.message && (
        <Notice tone="success">{displayMessage(state.message)}</Notice>
      )}
      <Row title="whzxc/agent-remote-control">
        <Button
          variant="ghost"
          onClick={() =>
            void openUrl(
              "https://github.com/whzxc/agent-remote-control",
            ).catch((e) => notify(String(e), true))
          }
        >
          GitHub <Icon icon={ExternalLink} />
        </Button>
      </Row>
    </Group>
  );
}
export function AppUpdateDialogs() {
  const s = updates.use(),
    active = s.phase !== "idle",
    downloading = s.phase === "downloading",
    progress = s.total ? Math.max(0, Math.min(100, s.downloaded / s.total * 100)) : 0;
  const actionLabel = s.phase === "installing"
    ? t("installingRestartingSoon")
    : downloading
      ? s.total
        ? t("updateDownloadSizeProgress", {
            size: (s.downloaded / 1048576).toFixed(1),
            total: (s.total / 1048576).toFixed(1),
            percent: Math.floor(progress),
          })
        : t("downloadingValueMb", { size: (s.downloaded / 1048576).toFixed(1) })
      : t(s.update?.ready ? "updateDownloadedInstall" : "downloadUpdate");
  return (
    <>
      <Dialog
        open={s.dialogOpen}
        onClose={dismissUpdate}
        title={
          available()
            ? t("versionValueIsAvailable", { version: s.update?.version })
            : t("appUpdates")
        }
        busy={active}
        footer={
          <>
            {available() && !active && (
              <Button variant="ghost" onClick={skipUpdate}>
                {t("skipThisVersion")}
              </Button>
            )}
            <span className="spacer" />
            {!active && <Button onClick={dismissUpdate}>{t("later")}</Button>}
            {s.phase === "downloading" && (
              <Button onClick={() => void cancelUpdate()}>
                {t("cancelDownload")}
              </Button>
            )}
            {available() && (
              <Button
                variant="primary"
                className="update-action"
                data-phase={s.phase}
                busy={s.phase === "installing"}
                aria-busy={active}
                disabled={active || s.checking}
                onClick={() => void installUpdate()}
              >
                {downloading && <Progress label={t("updateDownloadProgress")} value={progress} color="var(--on-action)" />}
                <span className="update-action-label" aria-live="polite">{actionLabel}</span>
              </Button>
            )}
          </>
        }
      >
        {s.checking && <p role="status">{t("checkingLabel")}</p>}
        {available() && (
          <>
            <p className="muted">
              {t("installationRestartsTheAppAndRestoresThePrevious")}
            </p>
            <pre className="release-notes">
              {s.update?.notes || t("aNewVersionIsReadyToDownloadAnd")}
            </pre>
          </>
        )}
        {s.error && (
          <Notice
            action={
              <Button onClick={() => void openDownloads()}>
                {t("downloadManually")} <Icon icon={ExternalLink} />
              </Button>
            }
          >
            {displayMessage(s.error)}
          </Notice>
        )}
        {s.message && <p role="status">{displayMessage(s.message)}</p>}
      </Dialog>
      <Dialog
        open={!!s.announcement}
        onClose={() =>
          updates.set((old) => ({ ...old, announcement: undefined }))
        }
        title={t("updatedToVersion", { version: s.announcement?.version })}
      >
        <pre className="release-notes">
          {s.announcement?.notes || t("updateCompleted")}
        </pre>
      </Dialog>
    </>
  );
}
