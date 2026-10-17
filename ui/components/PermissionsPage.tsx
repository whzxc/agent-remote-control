import { useEffect, useRef, useState } from "react";
import { Accessibility, ArrowLeft, Bell, Check, Circle, HardDrive, LogIn, Monitor, RefreshCw, Terminal, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { Button, Group, Icon, IconButton, Tooltip } from "./ui";
import { connector, notify } from "../state/connector";
import { useNow } from "../state/hooks";
import type { Ingress } from "../state/types";
import SourceIcon from "./SourceIcon";
import IngressDetailsDialog from "./IngressDetailsDialog";
import IngressDialog from "./IngressDialog";

type Item = { id: string; state: string; grantTarget?: string };
export type Readiness = { items: Item[]; observedAt: string };
const systemIds = ["accessibility", "screen-recording", "full-disk-access", "notifications", "login-start"];
const icons: Record<string, LucideIcon> = { accessibility: Accessibility, "screen-recording": Monitor, "full-disk-access": HardDrive, notifications: Bell, "login-start": LogIn, codex: Monitor, "claude-code": Terminal };
function combined(a?: Item, b?: Item): string {
  const states = [a?.state ?? "unknown", b?.state ?? "unknown"];
  return states.includes("missing") ? "missing" : states.includes("unknown") ? "unknown" : states.every(s => s === "not-applicable") ? "not-applicable" : "granted";
}
export default function PermissionsPage({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<Readiness>();
  const [busy, setBusy] = useState(false);
  const [details, setDetails] = useState<Ingress>();
  const [editing, setEditing] = useState<Ingress>();
  const { status } = connector.use();
  const currentLocale = locale.use();
  const now = useNow();
  const generation = useRef(0);
  const back = useRef<HTMLButtonElement>(null);
  const refresh = async () => {
    const request = ++generation.current;
    setBusy(true);
    try {
      const value = await api<Readiness>("permissions");
      if (request === generation.current) setData(value);
    } catch (error) {
      if (request === generation.current) notify(String(error), true);
    } finally { if (request === generation.current) setBusy(false); }
  };
  useEffect(() => {
    back.current?.focus();
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    let dispose: (() => void) | undefined;
    let closed = false;
    if (isDesktop) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) focus(); });
      if (closed) off(); else dispose = off;
    });
    return () => { closed = true; ++generation.current; dispose?.(); window.removeEventListener("focus", focus); };
  }, []);
  const find = (id: string) => data?.items.find(item => item.id === id);
  const disk = find("full-disk-access"), commandDisk = find("command-full-disk-access");
  const appName = disk?.grantTarget?.split("/").pop()?.replace(/\.app$/, "") || "Agent Remote Control";
  const rows = [
    ...systemIds.map(id => ({ id, state: id === "full-disk-access" ? combined(disk, commandDisk) : find(id)?.state ?? "unknown" })),
    { id: "codex", state: combined(find("codex-desktop"), find("codex-login")) },
    { id: "claude-code", state: find("claude-code")?.state ?? "unknown" },
  ];
  const mac = status?.platform === "darwin";
  const visible = rows.filter(row => row.state !== "not-applicable" && (mac || !systemIds.includes(row.id)));
  const connections = (status?.ingresses ?? []).map(entry => ({ entry, state: find("ingress:" + entry.id)?.state ?? "unknown" }));
  const missing = visible.filter(row => row.state === "missing").length + connections.filter(row => row.state === "missing").length;
  const unknown = visible.some(row => row.state === "unknown") || connections.some(row => row.state === "unknown");
  const minutes = data ? Math.max(0, Math.floor((now - Date.parse(data.observedAt)) / 60000)) : 0;
  const relative = minutes < 1 ? t("permissionsJustChecked") : t("permissionsCheckedAgo", {
    time: new Intl.RelativeTimeFormat(currentLocale).format(-Math.floor(minutes < 60 ? minutes : minutes < 1440 ? minutes / 60 : minutes / 1440), minutes < 60 ? "minute" : minutes < 1440 ? "hour" : "day"),
  });
  async function act(id: string) {
    if (id === "codex" || id === "claude-code") {
      await openUrl("https://github.com/whzxc/agent-remote-control/blob/main/docs/" + (currentLocale === "zh-CN" ? "zh-CN/" : "") + "getting-started.md");
      return;
    }
    setBusy(true);
    try {
      if (id === "login-start") await api("service", "POST", { enabled: true });
      else await api("permissions/request", "POST", { id });
      await refresh();
    } catch (e) { notify(String(e), true); }
    finally { setBusy(false); }
  }
  function badge(state: string, system: boolean, connection = false) {
    const ready = state === "granted";
    const key = state === "unknown" ? "permissionState.unknown" : connection ? (ready ? "permissionsVerified" : "permissionsUnverified") : ready ? (system ? "permissionsGranted" : "permissionState.granted") : system ? "permissionsNotGranted" : "permissionState.missing";
    return <span className="permission-badge" data-state={state}><Icon icon={ready ? Check : Circle} /><span>{t(key)}</span></span>;
  }
  function row(item: {id: string; state: string}) {
    const system = systemIds.includes(item.id);
    const authorization = system && item.id !== "login-start";
    return <div className="permission-row" key={item.id}>
      <Tooltip text={t("permissionTools." + item.id)}><span className="permission-symbol" tabIndex={0}><Icon icon={icons[item.id]} size={20} /></span></Tooltip>
      <div className="permission-copy">
        <h3>{t("permission." + item.id)}</h3>
        <p>{t("permissionUse." + item.id)}</p>
        {item.id === "full-disk-access" && disk && commandDisk && disk.state !== commandDisk.state && <p className="permission-hint">{t("permissionsDiskMismatch")}</p>}
      </div>
      <div className="permission-actions">
        {badge(item.state, authorization)}
        {item.state !== "granted" && <Button disabled={busy || (system && !isDesktop)} onClick={() => void act(item.id).catch(e => notify(String(e), true))}>
          {t(system ? item.id === "login-start" ? "permissionsEnable" : "permissionsGrant" : "permissionsInstructions")}
        </Button>}
      </div>
    </div>;
  }
  return <div className="permissions-page" onKeyDown={e => {
    if (e.key === "Escape" && !e.defaultPrevented && !details && !editing) { e.preventDefault(); e.stopPropagation(); onBack(); }
  }}>
    <header className="permissions-header">
      <div><IconButton ref={back} icon={ArrowLeft} label={t("permissionsBack")} onClick={onBack} /><h2>{t("permissionsTitle")}</h2></div>
      <Button busy={busy} onClick={() => void refresh()}>{!busy && <Icon icon={RefreshCw} />}{t("permissionsRefresh")}</Button>
    </header>
    <p className="permissions-summary" role="status">{!data ? t("permissionsLoading") : `${missing ? t("permissionsNeedAttention", {count: missing}) : t(unknown ? "permissionsSomeUnknown" : "permissionsAllReady")} · ${relative}`}</p>
    {data && <>
      {mac && <Group title={t("permissionsSystem")}><p className="permission-hint">{t("permissionsAppHint", {app: appName})}</p>{visible.filter(item => systemIds.includes(item.id)).map(row)}</Group>}
      <Group title={t("permissionsEnvironment")}>{visible.filter(item => !systemIds.includes(item.id)).map(row)}</Group>
      <Group title={t("permissionsConnections")}>
        {connections.length === 0 && <p className="permission-hint">{t("permissionsNoConnections")}</p>}
        {connections.map(({entry, state}) => <div className="permission-row" key={entry.id}>
          <span className="permission-symbol"><SourceIcon platform={entry.controlSource} /></span>
          <div className="permission-copy"><h3>{entry.name}</h3><p>{t("permissionUse.ingress")}</p></div>
          <div className="permission-actions">{badge(state, false, true)}{state !== "granted" && <Button onClick={() => setDetails(entry)}>{t("permissionsViewConnection")}</Button>}</div>
        </div>)}
      </Group>
    </>}
    {details && <IngressDetailsDialog ingress={details} onClose={() => setDetails(undefined)} onEdit={entry => { setDetails(undefined); setEditing(entry); }} />}
    {editing && <IngressDialog ingress={editing} onClose={() => setEditing(undefined)} onRemoved={() => { setEditing(undefined); void refresh(); }} onSaved={entry => { setEditing(undefined); setDetails(entry); void refresh(); }} />}
  </div>;
}
