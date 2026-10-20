import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  LayoutDashboard,
  Logs,
  Settings,
  X,
  Download,
  Maximize2,
  Minimize2,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { animate } from "motion";
import { reducedMotion } from "./motion/surface";
import { t, locale } from "./i18n";
import { isDesktop } from "./platform";
import { connector, notify, startConnector } from "./state/connector";
import { startAgents } from "./state/agents";
import { startAgentActivity, startSubscriptions } from "./state/subscriptions";
import { startTasks, tasks } from "./state/tasks";
import {
  startUpdateChecks,
  updates,
  checkUpdate,
  showUpdate,
  updateVisible,
  installDirect,
} from "./state/updates";
import { navigation, type Page } from "./state/navigation";
import { panelLayers, panelAnchorAt } from "./state/panels";
import {
  capturePanelOrigin,
} from "./components/panelMorph";
import { displayMessage } from "./messages";
import OAuthApproval from "./components/OAuthApproval";
import ConnectionOverview from "./components/ConnectionOverview";
import TasksPage from "./components/TasksPage";
import RecordsPage from "./components/RecordsPage";
import SettingsPage from "./components/SettingsPage";
import { AppUpdateDialogs } from "./components/AppUpdate";
import { Icon, IconButton, Notice, HoverScope } from "./components/ui";
import { api } from "./api";
import PermissionsPage from "./components/PermissionsPage";
import { permissions, permissionsReady, refreshPermissions, startPermissions } from "./state/permissions";
export default function App() {
  locale.use();
  const [oauthRequest, setOauthRequest] = useState<{ id: string }>();
  const { feedback, status } = connector.use(),
    taskState = tasks.use();
  updates.use();
  const permissionState = permissions.use();
  const ready = !!status && permissionsReady(status.ingresses);
  useEffect(() => {
    void refreshPermissions().catch(() => {});
  }, [JSON.stringify(status?.ingresses?.map(ingress => [ingress.enabled, ingress.toolPolicy]))]);

  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("arc-page");
    return ["overview", "settings", "logs", "tasks", "permissions"].includes(saved ?? "") ? saved as Page : "overview";
  });
  const [sheetWide, setSheetWide] = useState(false);
  const sheet = useRef<HTMLElement>(null),
    lastPage = useRef<Page>(page === "overview" ? "tasks" : page),
    sheetClosing = useRef(false),
    backdropDown = useRef(false);
  const layers = panelLayers.use();
  useEffect(() => { localStorage.setItem("arc-page", page); }, [page]);
  useEffect(() => {
    if (!isDesktop) return;
    // Keep drafts and active dialogs alive; only retire an idle hidden surface.
    const timer = setInterval(() => {
      if (document.querySelector('[role="dialog"], form') || updates.get().phase !== "idle" || updates.get().checking || updates.get().dialogOpen || updateVisible()) return;
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("release_main_window")).catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  useLayoutEffect(() => {
    if (page === "overview" || !sheet.current) return;
    const animation = reducedMotion() ? undefined : animate(sheet.current,
      { opacity: [0, 1], transform: ["translateY(6px)", "translateY(0)"] }, { duration: 0.16 });
    document.querySelector<HTMLElement>(".capsule-title")?.focus({ preventScroll: true });
    return () => animation?.stop();
  }, [page]);

  async function closeSheet(replacement?: HTMLElement) {
    const node = sheet.current;
    if (!node || sheetClosing.current) return;
    sheetClosing.current = true;
    if (!reducedMotion() && !replacement)
      await animate(node, { opacity: 0, transform: "translateY(6px)" }, { duration: 0.14 });
    sheetClosing.current = false;
    setPage("overview");
    requestAnimationFrame(() => {
      const target =
        replacement ??
        document.querySelector<HTMLElement>(
          `[data-page="${lastPage.current}"]`,
        );
      target?.focus({ preventScroll: true });
      if (replacement) replacement.click();
    });
  }

  function navigate(next: Page) {
    if (next !== "overview") {
      lastPage.current = next;
      setSheetWide(false);
    }
    setPage(next);
  }
  useEffect(() => {
    const stops = [
      startConnector(),
      startPermissions(),
      startSubscriptions(),
      startAgentActivity(),
      startAgents(),
      startTasks(),
      startUpdateChecks(),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
  useEffect(() => {
    if (!isDesktop) return;
    let stopped = false;
    const stops: (() => void)[] = [];
    void import("@tauri-apps/api/event").then(async ({ listen }) => {
      const listeners = await Promise.all([
        listen<string>("oauth:open", (e) => setOauthRequest({ id: e.payload })),
        listen<{ id: string; field: string }>("ingress:edit", (e) => {
          navigation.set((old) => ({ ...old, ingressEdit: e.payload }));
          navigate("overview");
        }),
        listen("permissions:open", () => navigate("permissions")),
        listen("codex:login", () => { void api("codex/login", "POST").catch((e: Error) => notify(e.message, true)); }),
        listen("updates:check", () => {
          showUpdate();
          void checkUpdate();
        }),
        listen<string>("navigate", (e) => {
          if (["overview", "settings", "logs", "tasks", "permissions"].includes(e.payload))
            navigate(e.payload as Page);
        }),
        listen<string>("subscriptions:open", (e) => {
          navigation.set((old) => ({ ...old, providerId: e.payload }));
          navigate("overview");
        }),
        listen<string>("connection-error", (e) => notify(e.payload, true)),
      ]);
      if (stopped) listeners.forEach((stop) => stop());
      else {
        stops.push(...listeners);
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("main_window_ready");
      }
    });
    return () => {
      stopped = true;
      stops.forEach((stop) => stop());
    };
  }, []);
  useEffect(() => {
    const handle = (event: Event) => {
      const url = new URL((event as CustomEvent<string>).detail);
      if (url.hostname === "ingress") {
        navigation.set(old => ({ ...old, ingressEdit: { id: url.searchParams.get("id") ?? "", field: url.searchParams.get("field") ?? "" } }));
        navigate("overview");
      } else if (url.hostname === "oauth") setOauthRequest({ id: url.searchParams.get("request") ?? "" });
      else if (url.hostname === "permissions") navigate("permissions");
      else if (url.hostname === "settings") navigate("settings");
      else if (url.hostname === "setup" && ["claude-login", "cloudflare-login"].includes(url.searchParams.get("target") ?? "")) {
        void api("setup/apply", "POST", {stepId: url.searchParams.get("target") === "claude-login" ? "claude-code-ready" : "cloudflare-login", input:{}}).catch((e: Error) => notify(e.message, true));
      }
      else if (url.hostname === "setup" && url.searchParams.get("target") === "codex-login") {
        void api("codex/login", "POST").catch((e: Error) => notify(e.message, true));
      }
    };
    window.addEventListener("arc:open-url", handle);
    return () => window.removeEventListener("arc:open-url", handle);
  }, []);
  const pending = taskState.records.filter(
    (r) => r.state === "awaiting-approval",
  ).length;
  const pages = [
    { id: "tasks" as const, label: t("tasks"), icon: LayoutDashboard },
    { id: "logs" as const, label: t("records"), icon: Logs },
    { id: "permissions" as const, label: t("permissionsTitle"), icon: ready ? ShieldCheck : ShieldAlert },
    { id: "settings" as const, label: t("settings"), icon: Settings },
  ];
  return (
    <div
      className={`app-scene ${sheetWide ? "sheet-wide" : ""} ${isDesktop ? "desktop" : ""} ${isDesktop && navigator.platform.toLowerCase().includes("mac") ? "mac" : ""}`}
      onClickCapture={(e) => capturePanelOrigin(e.target)}
      onKeyDown={(e) => {
        if (
          e.key === "Escape" &&
          !e.defaultPrevented &&
          page !== "overview" &&
          !layers.length
        ) {
          e.preventDefault();
          void closeSheet();
        }
        if (e.key === "Tab" && page !== "overview" && !layers.length) {
          const nodes = Array.from(
            document.querySelectorAll<HTMLElement>(
              '.page-sheet button:not(:disabled),.page-sheet input:not(:disabled),.page-sheet [tabindex="0"],.navigation-capsule .capsule-close',
            ),
          ).filter((n) => n.getClientRects().length && !n.closest("[inert]"));
          const index = nodes.indexOf(document.activeElement as HTMLElement);
          if (
            (e.shiftKey && index <= 0) ||
            (!e.shiftKey && index === nodes.length - 1)
          ) {
            e.preventDefault();
            (e.shiftKey ? nodes.at(-1) : nodes[0])?.focus();
          }
        }
      }}
    >
      {isDesktop && (
        <div className="window-drag-strip" data-tauri-drag-region />
      )}
      <main
        className="home-workspace"
        inert={page !== "overview" || layers.length > 0}
      >
        <ConnectionOverview visible={page === "overview"} />
      </main>
      {page !== "overview" && (
        <div
          className="sheet-backdrop"
          onPointerDown={(e) =>
            (backdropDown.current =
              e.button === 0 && e.target === e.currentTarget)
          }
          onPointerCancel={() => (backdropDown.current = false)}
          onClick={(e) => {
            if (
              backdropDown.current &&
              e.target === e.currentTarget &&
              !layers.length
            )
              void closeSheet(panelAnchorAt(e.clientX, e.clientY));
            backdropDown.current = false;
          }}
        />
      )}
      <div
        className={`navigation-surface ${page !== "overview" ? "expanded" : ""} ${updateVisible() ? "has-update" : ""}`}
        aria-hidden="true"
      />
      {page !== "overview" && (
        <section
          ref={sheet}
          className="page-sheet"
          data-panel-depth="1"
          data-recessed={layers.length > 0 || undefined}
          inert={layers.length > 0}
          aria-label={pages.find((item) => item.id === page)?.label}
        >
          <div className="page-sheet-content">
            <header className="sheet-header">
              <h1 className="capsule-title" tabIndex={-1}>
                {pages.find((item) => item.id === page)?.label}
                {page === "logs" && (
                  <span className="muted small records-count">
                    {t("recentRecords", { count: status?.logs.length ?? 0 })}
                  </span>
                )}
              </h1>
              {page === "permissions" && <IconButton
                icon={RefreshCw}
                label={t("permissionsRefresh")}
                busy={permissionState.loading}
                onClick={() => void refreshPermissions().catch(error => notify(String(error), true))}
              />}
              <IconButton
                className="panel-width-toggle"
                icon={sheetWide ? Minimize2 : Maximize2}
                label={t(sheetWide ? "restorePanelWidth" : "expandPanelWidth")}
                aria-pressed={sheetWide}
                onClick={() => setSheetWide(!sheetWide)}
              />
              <IconButton
                className="capsule-close"
                icon={X}
                label={t("backToHome")}
                onClick={() => void closeSheet()}
              />
            </header>
            <main
              className={`workspace ${page === "logs" ? "records-workspace" : ""}`}
            >
              {page === "tasks" ? (
                <TasksPage />
              ) : page === "logs" ? (
                <RecordsPage />
              ) : page === "permissions" ? (
                <PermissionsPage />
              ) : (
                <SettingsPage />
              )}
            </main>

          </div>
        </section>
      )}
      <nav
        className={`navigation-capsule ${page !== "overview" ? "expanded" : ""} ${updateVisible() ? "has-update" : ""}`}
        inert={page !== "overview" || layers.length > 0}
        aria-hidden={page !== "overview"}
        aria-label={t("mainNavigation")}
      >
        <HoverScope
          activeKey={page !== "overview" || layers.length > 0 ? "" : undefined}
          className="capsule-icons"
          inert={page !== "overview"}
          aria-hidden={page !== "overview"}
        >
          {updateVisible() && (
            <IconButton
              className="update-shortcut"
              icon={Download}
              label={t("viewUpdate")}
              onClick={() => void installDirect()}
            />
          )}{" "}
          {pages.map((item) => (
            <button
              key={item.id}
              data-panel-anchor
              data-page={item.id}
              data-hover-target={item.id}
              aria-label={item.label}
              onClick={() => navigate(item.id)}
            >
              <Icon icon={item.icon} size={20} />
              {item.id === "tasks" && pending > 0 && (
                <span className="task-count">{pending}</span>
              )}
            </button>
          ))}
        </HoverScope>
      </nav>
      {feedback.text && (
        <div className="app-feedback">
          <Notice
            tone={feedback.error ? "danger" : "success"}
            action={
              <IconButton
                icon={X}
                label={t("dismissMessage")}
                onClick={() => notify("")}
              />
            }
          >
            {displayMessage(feedback.text)}
          </Notice>
        </div>
      )}
      <AppUpdateDialogs />
      <OAuthApproval requested={oauthRequest} onClose={() => setOauthRequest(undefined)} />
    </div>
  );
}
