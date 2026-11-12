import DevicesWorkspace from './devices/DevicesWorkspace';
import { deviceLinkEnabled, observeDevices } from './devices/state';
import McpHub from './mcp/McpHub';
import { mcpHubEnabled } from './mcp/state';
import CoordinationCenter, { centerReturn } from './coordination/CoordinationCenter';
import { boardFocus, boardOpen, useBoardObservation } from './coordination/state';
import { agentPanel, ingressPanel } from './state/overviewPanels';
import { HomepageDisplay, StudioControls } from './display/Studio';
import { studioEnabled } from './display/state';
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
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Users,
  PawPrint,
  Cloud,
  Plug,
  Monitor,
} from "lucide-react";
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
import { onboarding, connectionSetup, connectionSwitch } from "./state/onboarding";
import { navigation, openConnections, type Page } from "./state/navigation";
import { layers as layerStore, captureLayerTrigger } from "./state/layers";
import { displayMessage } from "./messages";
import OAuthApproval from "./components/OAuthApproval";
import ConnectionOverview from "./components/ConnectionOverview";
import SettingsPage from "./components/SettingsPage";
import PlatformsPage from "./components/PlatformsPage";
import Onboarding from "./components/Onboarding";
import AddConnection from "./components/AddConnection";
import { usePrivacy } from "./state/privacy";
import { UpdateDock } from "./components/AppUpdate";
import { Button, Icon, IconButton, Notice, HoverScope, Panel } from "./components/ui";
import { api } from "./api";
import { LayerOwnerContext } from "./components/ui/TransientLayer";
import PermissionsPage from "./components/PermissionsPage";
import PetsPage from "./pets/PetsPage";
import { showPets } from "./pets/state";
import RelayHosting from "./components/RelayHosting";
import { relayHostingEnabled } from "./state/relay";
import TuningControls from "./topology/TuningControls";
import { permissions, permissionsReady, refreshPermissions, startPermissions } from "./state/permissions";
export default function App() {
  locale.use();
  const studio = studioEnabled.use();
  const deviceLink = deviceLinkEnabled.use();
  useEffect(observeDevices, []);
  const pets = showPets.use(), hosting = relayHostingEnabled.use(), mcp = mcpHubEnabled.use();
  const privateMode = usePrivacy();
  useLayoutEffect(() => { document.documentElement.dataset.privacy = String(privateMode); }, [privateMode]);
  const nav = navigation.use();
  const bulletinOpen = boardOpen.use();
  const returning = centerReturn.use(), taskSelection = agentPanel.use(), connectionSelection = ingressPanel.use();
  const updatePanelOpen = updates.use().panelOpen;
  const returnOpened = useRef(false);
  useLayoutEffect(() => {
    if (!returning) { returnOpened.current = false; return; }
    const opened = returning.kind === 'task' ? !!taskSelection : returning.kind === 'connection' ? !!connectionSelection : updatePanelOpen;
    if (opened) { returnOpened.current = true; return; }
    if (!returnOpened.current) return;
    const focusId = returning.focusId;
    centerReturn.set(undefined); boardFocus.set(focusId); boardOpen.set(true);
  }, [returning, taskSelection, connectionSelection, updatePanelOpen]);
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
    return ["overview", "settings", "accounts", "permissions", ...(pets ? ["pets"] : []), ...(hosting ? ["relay-hosting"] : []), ...(mcp ? ["mcp-hub"] : []), ...(deviceLink ? ["devices"] : [])].includes(saved ?? "") ? saved as Page : "overview";
  });
  const [sheetWide, setSheetWide] = useState(false);
  const flow = onboarding.use(), newConnection = connectionSetup.use();
  const welcome = flow?.step === "welcome" && page === "overview";
  const layers = layerStore.use();
  const modalOpen = layers.some(layer => layer.kind === 'dialog');
  const workspace = layers.find(layer => layer.kind === 'panel' && !layer.node?.dataset.panelDock);
  useBoardObservation(page === 'overview' && (!modalOpen || bulletinOpen));
  useEffect(() => { localStorage.setItem("arc-page", page); }, [page]);
  useLayoutEffect(() => {
    if ((page === "pets" && !pets) || (page === "relay-hosting" && !hosting) || (page === "mcp-hub" && !mcp) || (page === "devices" && !deviceLink)) {
      setPage("overview");
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-page="settings"]')?.focus({ preventScroll: true }));
    }
  }, [pets, hosting, mcp, deviceLink, page]);
  useEffect(() => {
    if (!isDesktop) return;
    // Keep drafts and active dialogs alive; only retire an idle hidden surface.
    const timer = setInterval(() => {
      if (document.querySelector('[role="dialog"], form') || updates.get().phase !== "idle" || updates.get().panelOpen || updateVisible()) return;
      void import("@tauri-apps/api/core").then(({ invoke }) => invoke("release_main_window")).catch(() => {});
    }, 30000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!nav.page) return;
    navigate(nav.page);
    navigation.set(old => ({ ...old, page: undefined }));
  }, [nav.page]);

  function navigate(next: Page) {
    if ((next === "pets" && !showPets.get()) || (next === "relay-hosting" && !relayHostingEnabled.get()) || (next === "mcp-hub" && !mcpHubEnabled.get())) return;
    if (next !== "overview") {
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
          if (["overview", "settings", "accounts", "permissions", "pets", "relay-hosting"].includes(e.payload))
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
    { id: "settings" as const, label: t("settings"), icon: Settings },
    { id: "accounts" as const, label: t("platforms.title"), icon: Users },
    { id: "permissions" as const, label: t("permissionsTitle"), icon: ready ? ShieldCheck : ShieldAlert },
    ...(pets ? [{ id: "pets" as const, label: t("pets.title"), icon: PawPrint }] : []),
    ...(hosting ? [{ id: "relay-hosting" as const, label: t("hosting.feature"), icon: Cloud }] : []),
    ...(deviceLink ? [{ id: "devices" as const, label: t("device.devices"), icon: Monitor }] : []),
    ...(mcp ? [{ id: "mcp-hub" as const, label: t("mcp.title"), icon: Plug }] : []),
  ];
  return (
    <div role="region" aria-label="ARC homepage"
      className={`app-scene ${isDesktop ? "desktop" : ""} ${isDesktop && navigator.platform.toLowerCase().includes("mac") ? "mac" : ""}`}
      data-display={studio ? "studio" : undefined}
      onClickCapture={(e) => captureLayerTrigger(e.target)}

    >
      <HomepageDisplay headerVisible={page === "overview" && !welcome && !modalOpen && !workspace} />
      {isDesktop && (
        <div className="window-drag-strip" data-tauri-drag-region />
      )}
      <main
        className="home-workspace"
        inert={page !== "overview" || modalOpen || !!workspace}
      >
        <ConnectionOverview visible={page === "overview"} />
      </main>
      {page !== "overview" && (page === "devices" ?
        <DevicesWorkspace expanded={sheetWide} onToggleWidth={() => setSheetWide(!sheetWide)} onClose={() => setPage("overview")} /> : page === "mcp-hub" ?
        <McpHub expanded={sheetWide} onToggleWidth={() => setSheetWide(!sheetWide)} onClose={() => setPage("overview")} /> : page === "relay-hosting" ?
        <RelayHosting expanded={sheetWide} onToggleWidth={() => setSheetWide(!sheetWide)} onClose={() => setPage("overview")} /> :
        <Panel key={page} role="region" size="l" title={<>{pages.find(item => item.id === page)?.label}
          {page === "settings" && nav.settingsExperimental && <><span aria-hidden="true"> / </span>{t("topology.experimental")}</>}</>}
          expanded={sheetWide} onToggleWidth={() => setSheetWide(!sheetWide)}
          onClose={() => setPage("overview")} returnFocus={`[data-page="${page}"]`}
          viewKey={page === "settings" && nav.settingsExperimental ? "experimental" : page}
          leading={page === "settings" && nav.settingsExperimental ? <IconButton icon={ArrowLeft} label={t("back")} onClick={() => navigation.set(old => ({ ...old, settingsExperimental: undefined }))} /> : undefined}
          onEscapeKeyDown={event => { if (page === "settings" && nav.settingsExperimental) { event.preventDefault(); navigation.set(old => ({ ...old, settingsExperimental: undefined })); } }}
          actions={page === "permissions" ? <IconButton icon={RefreshCw} label={t("permissionsRefresh")} busy={permissionState.loading}
            onClick={() => void refreshPermissions().catch(error => notify(String(error), true))} /> : undefined}>
          <div className={`workspace ${page === "accounts" ? "accounts-workspace-container" : ""}`}>
            {page === "permissions" ? <PermissionsPage /> : page === "accounts" ? <PlatformsPage /> : page === "pets" ? <PetsPage />
              : <SettingsPage />}
          </div>
        </Panel>
      )}
      <LayerOwnerContext.Provider value={workspace?.id}>
      <nav
        className="navigation-capsule"
        data-workspace-switcher
        style={{ zIndex: layerStore.stack().switcher }}
        inert={welcome || modalOpen}
        aria-hidden={welcome || undefined}
        hidden={welcome}
        aria-label={t("mainNavigation")}
      >
        <HoverScope
          activeKey={modalOpen ? "" : page === "overview" ? undefined : page}
          className="capsule-icons"
        >
          {pages.map((item) => (
            <button
              key={item.id}
              data-panel-anchor
              data-page={item.id}
              data-hover-target={item.id}
              aria-label={item.label}
              aria-pressed={page === item.id}
              onClick={() => layerStore.switchPanel(() => navigate(page === item.id ? "overview" : item.id))}
            >
              <Icon icon={item.icon} size={20} />

            </button>
          ))}
          <TuningControls available={page === "overview" && !welcome && !modalOpen && !workspace} />
          <StudioControls available={studio && page === "overview" && !welcome && !modalOpen && !workspace} />
          <UpdateDock />
        </HoverScope>
      </nav>
      </LayerOwnerContext.Provider>
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
      {flow && <Onboarding returnFocus={page === "accounts" ? "[data-platform-add]" : undefined} />}
      {newConnection && <AddConnection options={newConnection} onClose={() => connectionSetup.set(undefined)} onAdded={id => {
        if (newConnection.forSwitch) connectionSwitch.set(old => old && { ...old, ingressId: id });
        if (newConnection.forSource) onboarding.set(old => old?.step === "connection" ? { ...old, step: "address", ingressId: id, baseline: (connector.get().status?.ingresses.find(i => i.id === id)?.oauth?.pending ?? []).map(p => p.id) } : old);
        if (!newConnection.forSource && !newConnection.forSwitch) navigation.set(old => ({ ...old, page: "overview", connectionsOpen: true, remoteConnectionId: id }));
        connectionSetup.set(undefined);
      }} />}
      {bulletinOpen && <CoordinationCenter />}
      <OAuthApproval inlineEnabled={page === "overview"} requested={oauthRequest} onClose={() => setOauthRequest(undefined)} />
    </div>
  );
}
