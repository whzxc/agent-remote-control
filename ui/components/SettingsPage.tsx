import { notificationsPreference } from "../state/store";
import { useEffect, useState } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { t, language, languageOptions, setLanguage } from "../i18n";
import { theme, themeColor, themeColors, type Theme } from "../theme";
import { api } from "../api";
import { isDesktop } from "../platform";
import { connector, run, notify, refreshConnector } from "../state/connector";
import { useInterval } from "../state/hooks";
import type { Service } from "../state/types";
import { Button, Group, Row, Switch, SingleChoice, Input, Field } from "./ui";
import { AppUpdate } from "./AppUpdate";
export default function SettingsPage() {
  const { status, busy } = connector.use();
  const currentTheme = theme.use(),
    color = themeColor.use(),
    currentLanguage = language.use();
  const [proxyMode, setProxyMode] = useState(
      status?.config.proxyMode || "system",
    ),
    [proxyUrl, setProxyUrl] = useState(status?.config.proxyUrl || ""),
    [proxyError, setProxyError] = useState("");
  const [appearance, setAppearance] = useState({
      showMenuBar: true,
      showDock: true,
    }),
    [appearanceReady, setAppearanceReady] = useState(false),
    [service, setService] = useState<Service>();
  const notifications = notificationsPreference.use();
  const mac = isDesktop && navigator.platform.toLowerCase().includes("mac");
  useEffect(() => {
    if (mac)
      void api<typeof appearance>("appearance")
        .then((value) => {
          setAppearance(value);
          setAppearanceReady(true);
        })
        .catch((e) => notify(String(e), true));
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
  async function saveProxy(mode = proxyMode) {
    setProxyError("");
    if (mode === "custom") {
      try {
        const url = new URL(proxyUrl.trim());
        if (!["http:", "https:"].includes(url.protocol)) throw new Error();
      } catch {
        setProxyError(t("validProxyUrl"));
        return;
      }
    }
    await run("network", async () => {
      await api("network", "PUT", {
        proxyMode: mode,
        proxyUrl: mode === "custom" ? proxyUrl.trim() : "",
      });
      await refreshConnector();
      const current = connector.get().status;
      setProxyMode(current?.config.proxyMode || "system");
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
  }) {
    await run("task-settings", async () => {
      await api("task-settings", "PUT", patch);
      await refreshConnector();
    });
  }
  return (
    <div className="settings-page">
      <Group title={t("behavior")}>
        <Row
          title={t("automaticallyOpenCodexTasks")}
          description={t("whenDisabledNewTasksRunInTheBackground")}
        >
          <Switch
            label={t("automaticallyOpenCodexTasks")}
            checked={status?.autoOpenCodex !== false}
            disabled={!!busy || !status}
            onChange={(value) => void saveTask({ autoOpenCodex: value })}
          />
        </Row>
        <Row
          title={t("taskApprovalMode")}
          description={t("askForConfirmationByDefaultTheCloudCan")}
        >
          <Switch
            label={t("taskApprovalMode")}
            checked={!!status?.taskApprovalEnabled}
            disabled={!!busy || !status}
            onChange={(value) => void saveTask({ enabled: value })}
          />
        </Row>
      </Group>
      <Group title={t("general")}>
        <Row title={t("connectAtSystemSignIn")}>
          <Switch
            label={t("connectAtSystemSignIn")}
            checked={!!service?.enabled}
            disabled={!!busy || !service?.supported}
            onChange={(enabled) =>
              void run("startup", async () =>
                setService(await api<Service>("service", "POST", { enabled })),
              )
            }
          />
        </Row>
        {isDesktop && (
          <Row title={t("connectionNotifications")} description={t("connectionNotificationsDescription")}>
            <Switch
              label={t("connectionNotifications")}
              checked={notifications}
              onChange={(value) => {
                notificationsPreference.set(value);
              }}
            />
          </Row>
        )}
        <Row title={t("language")}>
          <SingleChoice
            value={currentLanguage}
            onChange={setLanguage}
            label={t("language")}
            options={languageOptions.map(option => option.value === "auto" ? { ...option, label: t("system") } : option)}
          />
        </Row>
        <Row title={t("appearance")}>
          <SingleChoice
            value={currentTheme}
            onChange={(value) => theme.set(value as Theme)}
            label={t("appearance")}
            options={[
              { value: "system", label: t("system"), icon: Monitor },
              { value: "light", label: t("light"), icon: Sun },
              { value: "dark", label: t("dark"), icon: Moon },
            ]}
          />
        </Row>
        <Row title={t("themeColor")}>
          <SingleChoice
            swatches
            value={color}
            onChange={(value) =>
              themeColor.set(value as keyof typeof themeColors)
            }
            label={t("themeColor")}
            options={Object.entries(themeColors).map(([value, color]) => ({
              value,
              label: t(color.label),
              color: color.light,
            }))}
          />
        </Row>
        {mac && (
          <Row title={t("showAppIn")}>
            <SingleChoice
              value={
                appearance.showMenuBar
                  ? appearance.showDock
                    ? "all"
                    : "menu"
                  : "dock"
              }
              disabled={!!busy || !appearanceReady}
              label={t("showAppIn")}
              onChange={(position) =>
                void run("appearance", async () =>
                  setAppearance(
                    await api<typeof appearance>("appearance", "PUT", {
                      showMenuBar: position !== "dock",
                      showDock: position !== "menu",
                    }),
                  ),
                )
              }
              options={[
                { value: "all", label: t("all") },
                { value: "menu", label: t("menuBarOnly") },
                { value: "dock", label: t("dockOnly") },
              ]}
            />
          </Row>
        )}
      </Group>
      <Group title={t("network")}>
        <Row
          title={t("proxy")}
          description={t("useTheSystemProxyOrAProxyJust")}
        >
          <SingleChoice
            value={proxyMode}
            disabled={!!busy}
            label={t("proxyMode")}
            onChange={(value) => {
              setProxyMode(value as typeof proxyMode);
              setProxyError("");
              if (value !== "custom") void saveProxy(value as typeof proxyMode);
            }}
            options={[
              { value: "system", label: t("systemProxy") },
              { value: "direct", label: t("noProxy") },
              { value: "custom", label: t("custom") },
            ]}
          />
        </Row>
        {proxyMode === "custom" && (
          <Field id="proxy-url" label={t("proxyUrl")} error={proxyError}>
            <form
              className="actions"
              onSubmit={(e) => {
                e.preventDefault();
                void saveProxy();
              }}
            >
              <Input
                id="proxy-url"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="http://127.0.0.1:7890"
                aria-invalid={!!proxyError}
                aria-describedby={proxyError ? "proxy-url-error" : undefined}
                disabled={!!busy}
              />
              <Button type="submit" variant="primary" disabled={!!busy}>
                {t("save")}
              </Button>
            </form>
          </Field>
        )}
      </Group>
      <AppUpdate />
    </div>
  );
}
