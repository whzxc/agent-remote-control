import PetsPage, { PetsSwitch } from "./pets/PetsPage";
import { ArrowLeft } from "lucide-react";
import { scenarioName } from "./scenarioMode";
import { captureRequest, type PanelRequest } from "./acceptance";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Settings,
  X,
  Maximize2,
  Minimize2,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Users,
  PawPrint,
} from "lucide-react";
import { animate } from "motion";
import { reducedMotion } from "./motion/surface";
import { t, locale } from "./i18n";
import { copyText, isDesktop } from "./platform";
import { connector, notify, startConnector } from "./state/connector";
import { startAgents } from "./state/agents";
import { startSubscriptions } from "./state/subscriptions";
import { startAgentActivity } from "./state/activity";
import { startTasks } from "./state/tasks";
import {
  startUpdateChecks,
  updates,
  checkUpdate,
  showUpdate,
  updateVisible,
} from "./state/updates";
import { onboarding } from "./state/onboarding";
import { navigation, openConnections, type Page } from "./state/navigation";
import { panelLayers, panelAnchorAt } from "./state/panels";
import {
  capturePanelOrigin,
} from "./components/panelMorph";
import { displayMessage } from "./messages";
import OAuthApproval from "./components/OAuthApproval";
import ConnectionOverview from "./components/ConnectionOverview";
import SettingsPage from "./components/SettingsPage";
import PlatformsPage from "./components/PlatformsPage";
import { usePrivacy } from "./state/privacy";
import { UpdateDock, UpdateOutcome } from "./components/AppUpdate";
import { Button, Icon, IconButton, Notice, HoverScope } from "./components/ui";
import { api } from "./api";
import PermissionsPage from "./components/PermissionsPage";
import { permissions, permissionsReady, refreshPermissions, startPermissions } from "./state/permissions";
export default function App() {
  locale.use();
  const privateMode = usePrivacy();
  useLayoutEffect(() => { document.documentElement.dataset.privacy = String(privateMode); }, [privateMode]);
  const nav = navigation.use();
  const [oauthRequest, setOauthRequest] = useState<{ id: string }>();
  const { feedback, status } = connector.use();
  updates.use();
  const permissionState = permissions.use();
  const ready = !!status && permissionsReady(status.ingresses);
  useEffect(() => {
    void refreshPermissions().catch(() => {});
  }, [JSON.stringify(status?.ingresses?.map(ingress => [ingress.enabled, ingress.toolPolicy]))]);

  const [page, setPage] = useState<Page>(() => {
    const saved = localStorage.getItem("arc-page");
    return ["overview", "settings", "accounts", "permissions", "pets"].includes(saved ?? "") ? saved as Page : "overview";
  });
  const [sheetWide, setSheetWide] = useState(false);
  const sheet = useRef<HTMLElement>(null),
    lastPage = useRef<Page>(page === "overview" ? "accounts" : page),
    sheetClosing = useRef(false),
    backdropDown = useRef(false);
  const welcome = onboarding.use()?.step === "welcome" && page === "overview";
  const layers = panelLayers.use();
  const modalOpen = layers.some(layer => !layer.dataset.panelDock);
  useEffect(() => { localStorage.setItem("arc-page", page); }, [page]);
  useEffect(() => {
    if (!isDesktop) return;
    // Keep drafts and active dialogs alive; only retire an idle hidden surface.
    const timer = setInterval(() => {
      if (document.querySelector('[role="dialog"], form') || updates.get().snapshot.state !== "idle" || updates.get().panelOpen || updateVisible()) return;
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

  useEffect(() => {
    if (!nav.page) return;
    navigate(nav.page);
    navigation.set(old => ({ ...old, page: undefined }));
  }, [nav.page]);

  function navigate(next: Page) {
    if (next !== "overview") {
      lastPage.current = next;
      setSheetWide(false);
    }
    setPage(next);
  }
  useEffect(() => {
    if (scenarioName) return;
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
        listen<{ id: string; panel?: PanelRequest }>("acceptance:snapshot", e => { void captureRequest(e.payload, () => navigate("overview")); }),
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
          if (e.payload === "remote") { openConnections(); return; }
          if (["tasks", "logs"].includes(e.payload)) { navigate("overview"); return; }
          if (["overview", "settings", "accounts", "permissions", "pets"].includes(e.payload))
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
      else if (url.hostname === "remote") openConnections();
      else if (url.hostname === "accounts") navigate("accounts");
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
  const pages = [
    { id: "accounts" as const, label: t("platforms.title"), icon: Users },
    { id: "permissions" as const, label: t("permissionsTitle"), icon: ready ? ShieldCheck : ShieldAlert },
    { id: "settings" as const, label: t("settings"), icon: Settings },
    { id: "pets" as const, label: t("pets.title"), icon: PawPrint },
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
          if (page === "settings" && nav.settingsExtras) {
            navigation.set(old => ({ ...old, settingsExtras: undefined }));
          } else void closeSheet();
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
        inert={page !== "overview" || modalOpen}
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
        hidden={welcome}
        className={`navigation-surface ${updateVisible() ? "w-60" : "w-48"} ${page !== "overview" ? "expanded" : ""} ${updateVisible() ? "has-update" : ""}`}
        aria-hidden="true"
      />
      {page !== "overview" && (
        <section
          ref={sheet}
          className="page-sheet"
          data-panel-depth="1"
          data-recessed={modalOpen || undefined}
          inert={modalOpen}
          aria-label={pages.find((item) => item.id === page)?.label}
        >
          <div className="page-sheet-content">
            <header className="sheet-header">
              {page === "settings" && nav.settingsExtras && <IconButton icon={ArrowLeft} label={t("back")} onClick={() => navigation.set(old => ({ ...old, settingsExtras: undefined }))} />}
              <h1 className="capsule-title" tabIndex={-1}>
                {pages.find((item) => item.id === page)?.label}
                {page === "settings" && nav.settingsExtras && <><span className="settings-breadcrumb-divider" aria-hidden="true"> / </span><span>{t("extras.title")}</span></>}

              </h1>
              {page === "pets" && <PetsSwitch />}
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
              className={`workspace ${page === "accounts" ? "accounts-workspace-container" : ""}`}
            >
              {page === "pets" ? <PetsPage /> : page === "permissions" ? (
                <PermissionsPage />
              ) : page === "accounts" ? (
                <PlatformsPage />

              ) : (
                <SettingsPage />
              )}
            </main>

          </div>
        </section>
      )}
      <nav
        className={`navigation-capsule ${updateVisible() ? "w-60" : "w-48"} ${page !== "overview" ? "expanded" : ""} ${updateVisible() ? "has-update" : ""}`}
        inert={welcome || page !== "overview" || modalOpen}
        aria-hidden={welcome || page !== "overview"}
        hidden={welcome}
        aria-label={t("mainNavigation")}
      >
        <HoverScope
          activeKey={page !== "overview" || modalOpen ? "" : undefined}
          className="capsule-icons justify-center"
          inert={page !== "overview"}
          aria-hidden={page !== "overview"}
        >
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

            </button>
          ))}
          <UpdateDock />
        </HoverScope>
      </nav>
      {feedback.text && (
        <div className="app-feedback">
          <Notice
            tone={feedback.error ? "danger" : "success"}
            action={
              <>{feedback.copy && <Button onClick={() => void copyText(feedback.copy!).catch(() => notify(t("connect.actionFailed"), true))}>{t("copy")}</Button>}<IconButton
                icon={X}
                label={t("dismissMessage")}
                onClick={() => notify("")}
              /></>
            }
          >
            {displayMessage(feedback.text)}
          </Notice>
        </div>
      )}
      <UpdateOutcome />
      <OAuthApproval inlineEnabled={page === "overview"} requested={oauthRequest} onClose={() => setOauthRequest(undefined)} />
    </div>
  );
}
