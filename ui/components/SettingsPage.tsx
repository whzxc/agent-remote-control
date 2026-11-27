import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../api";
import {
  deviceLinkEnabled,
  deviceSnapshot,
  setControllerSources,
} from "../devices/state";
import { language, setLanguage, t } from "../i18n";
import { isDesktop } from "../platform";
import {
  connector,
  refreshConnector,
  run as runGlobal,
} from "../state/connector";
import { useInterval } from "../state/hooks";
import { navigation } from "../state/navigation";
import { setPrivacy, usePrivacy } from "../state/privacy";
import { notificationsPreference } from "../state/store";
import { tasks } from "../state/tasks";
import type { Service } from "../state/types";
import { theme, themeColor, themeColors, type Theme } from "../theme";
import { topologyMode } from "../topology/accountState";
import { AppUpdate } from "./AppUpdate";
import DesktopRecoveryNotice, {
  awaitsDesktopDecision,
} from "./DesktopRecoveryNotice";
import ExperimentalSettings from "./ExperimentalSettings";
import StorageSettings from "./StorageSettings";
import { Button } from "./kit/button";
import {
  GeneralSettingsView,
  type AppPresenceMode,
  type DesktopRecoveryMode,
  type ProxyMode,
} from "./settings/GeneralSettingsView";
import { useDialogFeedback } from "./ui/Dialog";
import { usePanelState } from "./ui/Panel";
import { useSubmittedDirty } from "./ui/useSubmittedDirty";

export default function SettingsPage() {
  const notify = useDialogFeedback();
  const run = (label: string, action: () => Promise<unknown>) =>
    runGlobal(label, action, (message) => notify(message, true));

  const { status, busy } = connector.use();
  const pendingDesktop = tasks.use().records.filter(awaitsDesktopDecision);
  const { settingsExperimental } = navigation.use();
  const previousSettings = useRef<string | undefined>(undefined);
  useLayoutEffect(() => {
    if (settingsExperimental) {
      document
        .querySelector<HTMLElement>(".panel-title")
        ?.focus({ preventScroll: true });
      document.querySelector(".layer-panel > .dialog-body")?.scrollTo({ top: 0 });
    } else if (previousSettings.current) {
      document.getElementById(previousSettings.current)?.focus();
    }
    previousSettings.current = settingsExperimental
      ? "settings-experimental-entry"
      : undefined;
  }, [settingsExperimental]);

  const currentTheme = theme.use();
  const color = themeColor.use();
  const currentLanguage = language.use();
  const [proxyMode, setProxyMode] = useState<ProxyMode>(
    (status?.config.proxyMode as ProxyMode | undefined) || "system",
  );
  const [proxyUrl, setProxyUrl] = useState(status?.config.proxyUrl || "");
  const [proxyError, setProxyError] = useState("");
  const [appearance, setAppearance] = useState({
    showMenuBar: true,
    showDock: true,
  });
  const [appearanceReady, setAppearanceReady] = useState(false);
  const [service, setService] = useState<Service>();
  const [delayDraft, setDelayDraft] = useState<string>();
  const savedDelay = String(status?.requestRoutingDelaySeconds ?? 15);
  const proxyDraft = useSubmittedDirty(
    { mode: proxyMode, url: proxyMode === "custom" ? proxyUrl : "" },
    proxyMode !== (status?.config.proxyMode || "system") ||
      (proxyMode === "custom" && proxyUrl !== (status?.config.proxyUrl || "")),
  );
  usePanelState({
    busy: !!busy,
    dirty:
      proxyDraft.dirty || (delayDraft !== undefined && delayDraft !== savedDelay),
  });

  const controllerDevice = deviceSnapshot.use()?.controller;
  const deviceLink = deviceLinkEnabled.use();
  const notifications = notificationsPreference.use();
  const topology = topologyMode.use();
  const privateMode = usePrivacy();
  const mac = isDesktop && navigator.platform.toLowerCase().includes("mac");

  useEffect(() => {
    if (mac)
      void api<typeof appearance>("appearance")
        .then((value) => {
          setAppearance(value);
          setAppearanceReady(true);
        })
        .catch((error) => notify(String(error), true));
  }, [mac]);

  useInterval(
    () => {
      void api<Service>("service")
        .then(setService)
        .catch(() => {});
    },
    5000,
    true,
  );

  async function saveProxy(mode: ProxyMode = proxyMode) {
    setProxyError("");
    if (mode === "custom") {
      try {
        const url = new URL(proxyUrl.trim());
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        setProxyError(t("validProxyUrl"));
        document.getElementById("proxy-url")?.focus();
        return;
      }
    }
    proxyDraft.submit({ mode, url: mode === "custom" ? proxyUrl : "" });
    await run("network", async () => {
      await api("network", "PUT", {
        proxyMode: mode,
        proxyUrl: mode === "custom" ? proxyUrl.trim() : "",
      });
      await refreshConnector();
      const current = connector.get().status;
      setProxyMode(
        (current?.config.proxyMode as ProxyMode | undefined) || "system",
      );
      setProxyUrl(current?.config.proxyUrl || "");
      notify(
        t(
          current?.connection?.running
            ? "proxySavedReconnectToApplyNewDownloadsUse"
            : "proxySettingsSaved",
        ),
      );
    });
  }

  async function saveTask(patch: {
    enabled?: boolean;
    autoOpenCodex?: boolean;
    desktopRecovery?: DesktopRecoveryMode;
    notificationsEnabled?: boolean;
    requestRoutingDelaySeconds?: number;
  }) {
    await run("task-settings", async () => {
      await api("task-settings", "PUT", patch);
      await refreshConnector();
    });
  }

  if (settingsExperimental) return <ExperimentalSettings />;

  const appPresence: AppPresenceMode = appearance.showMenuBar
    ? appearance.showDock
      ? "all"
      : "menu"
    : "dock";

  return (
    <GeneralSettingsView
      routingDelay={delayDraft ?? savedDelay}
      onRoutingDelayChange={setDelayDraft}
      onRoutingDelayCommit={(seconds, valid) => {
        if (
          valid &&
          Number.isInteger(seconds) &&
          seconds !== status?.requestRoutingDelaySeconds
        ) {
          void saveTask({ requestRoutingDelaySeconds: seconds }).finally(() =>
            setDelayDraft(undefined),
          );
        } else {
          setDelayDraft(undefined);
        }
      }}
      notificationsEnabled={status?.notificationsEnabled !== false}
      onNotificationsEnabledChange={(value) =>
        void saveTask({ notificationsEnabled: value })
      }
      autoOpenCodex={status?.autoOpenCodex !== false}
      onAutoOpenCodexChange={(value) => void saveTask({ autoOpenCodex: value })}
      showDesktopRecovery={
        status?.platform === "darwin" && Boolean(status.autoOpenCodex)
      }
      desktopRecovery={status?.desktopRecovery ?? "prompt"}
      onDesktopRecoveryChange={(value) =>
        void saveTask({ desktopRecovery: value })
      }
      recoveryNotices={
        pendingDesktop.length > 0
          ? pendingDesktop.map((record) => (
              <DesktopRecoveryNotice key={record.requestId} record={record} />
            ))
          : undefined
      }
      taskApprovalEnabled={!!status?.taskApprovalEnabled}
      onTaskApprovalEnabledChange={(value) => void saveTask({ enabled: value })}
      taskSettingsDisabled={!!busy || !status}
      startAtLogin={!!service?.enabled}
      startAtLoginDisabled={!!busy || !service?.supported}
      onStartAtLoginChange={(enabled) =>
        void run("startup", async () =>
          setService(await api<Service>("service", "POST", { enabled })),
        )
      }
      showConnectionNotifications={isDesktop}
      connectionNotifications={notifications}
      onConnectionNotificationsChange={(value) =>
        notificationsPreference.set(value)
      }
      language={currentLanguage}
      onLanguageChange={setLanguage}
      theme={currentTheme}
      onThemeChange={(value) => theme.set(value as Theme)}
      themeColor={color}
      themeColorOptions={Object.entries(themeColors).map(([value, swatch]) => ({
        value,
        label: t(swatch.label),
        swatch: `linear-gradient(90deg, ${"sourceLight" in swatch ? swatch.sourceLight : swatch.light} 0% 50%, ${swatch.light} 50% 100%)`,
      }))}
      onThemeColorChange={(value) =>
        themeColor.set(value as keyof typeof themeColors)
      }
      showAppPresence={mac}
      appPresence={appPresence}
      appPresenceDisabled={!!busy || !appearanceReady}
      onAppPresenceChange={(position) =>
        void run("appearance", async () =>
          setAppearance(
            await api<typeof appearance>("appearance", "PUT", {
              showMenuBar: position !== "dock",
              showDock: position !== "menu",
            }),
          ),
        )
      }
      topologyMode={topology}
      onTopologyModeChange={(value) => topologyMode.set(value)}
      showUpstreamSources={Boolean(deviceLink && controllerDevice)}
      upstreamSources={controllerDevice?.showUpstreamSources === true}
      upstreamSourcesDisabled={!!busy}
      onUpstreamSourcesChange={(show) =>
        void run("device-sources", () => setControllerSources(show))
      }
      privateMode={privateMode}
      onPrivateModeChange={setPrivacy}
      proxyMode={proxyMode}
      proxyDisabled={!!busy}
      onProxyModeChange={(value) => {
        setProxyMode(value);
        setProxyError("");
        if (value !== "custom") void saveProxy(value);
      }}
      proxyUrl={proxyUrl}
      proxyError={proxyError}
      onProxyUrlChange={setProxyUrl}
      onProxySubmit={() => void saveProxy()}
      storageSection={<StorageSettings />}
      aboutSection={
        <AppUpdate>
          <Button
            id="settings-experimental-entry"
            size="sm"
            variant="ghost"
            onClick={() =>
              navigation.set((old) => ({ ...old, settingsExperimental: true }))
            }
          >
            {t("topology.experimental")}
            <ChevronRight
              size={14}
              strokeWidth={1.75}
              absoluteStrokeWidth
              aria-hidden="true"
            />
          </Button>
        </AppUpdate>
      }
    />
  );
}
