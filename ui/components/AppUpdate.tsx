import { ExternalLink } from "lucide-react";
import { t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { connector, notify } from "../state/connector";
import {
  updates,
  autoCheck,
  autoDownload,
  available,
  updateVisible,
  checkUpdate,
  showUpdate,
  dismissUpdate,
  setAutoDownload,
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
  Switch,
  Notice,
  Progress,
  Icon,
} from "./ui";
import { displayMessage } from "../messages";
export function AppUpdate() {
  const { status } = connector.use(),
    state = updates.use(),
    checking = state.checking,
    active = state.phase !== "idle",
    automatic = autoCheck.use(),
    download = autoDownload.use();
  return (
    <Group title={t("aboutApp")}>
      <Row title={`Local Connector v${status?.version ?? "—"}`}>
        <Button
          busy={checking}
          disabled={!isDesktop || active}
          onClick={() => void checkUpdate()}
        >
          {t("checkForUpdates")}
        </Button>
      </Row>
      {isDesktop && (
        <Row title={t("automaticallyCheckForUpdates")} description={t("autoCheckDescription")}>
          <Switch
            label={t("automaticallyCheckForUpdates")}
            checked={automatic}
            onChange={autoCheck.set}
          />
        </Row>
      )}
      <Row title={t("automaticallyDownloadUpdates")}>
        <Switch
          label={t("automaticallyDownloadUpdates")}
          checked={download}
          onChange={setAutoDownload}
        />
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
      <Row title="whzxc/chatgpt-local-connector">
        <Button
          variant="ghost"
          onClick={() =>
            void openUrl(
              "https://github.com/whzxc/chatgpt-local-connector",
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
    active = s.phase !== "idle";
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
                busy={active}
                disabled={s.checking}
                onClick={() => void installUpdate()}
              >
                {t(s.update?.ready ? "installUpdate" : "downloadAndInstall")}
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
        {active && (
          <div role="status">
            <p>
              {s.phase === "installing"
                ? t("installingRestartingSoon")
                : t("downloadingValueMb", {
                    size: (s.downloaded / 1048576).toFixed(1),
                  })}
            </p>
            <Progress
              label={t("updateDownloadProgress")}
              value={s.total ? (s.downloaded / s.total) * 100 : 0}
            />
          </div>
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
