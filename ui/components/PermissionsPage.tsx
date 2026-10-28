import { useEffect, useState } from "react";
import { Accessibility, Bell, Check, Circle, HardDrive, LogIn, Monitor, Terminal, type LucideIcon } from "lucide-react";
import { api } from "../api";
import { locale, t } from "../i18n";
import { isDesktop, openUrl } from "../platform";
import { Button, Group, Icon, Tooltip } from "./ui";
import { connector, notify } from "../state/connector";
import { permissions, refreshPermissions, type PermissionItem } from "../state/permissions";

const systemIds = ["accessibility", "screen-recording", "full-disk-access", "notifications", "login-start"];
const icons: Record<string, LucideIcon> = { accessibility: Accessibility, "screen-recording": Monitor, "full-disk-access": HardDrive, notifications: Bell, "login-start": LogIn, codex: Monitor, "claude-code": Terminal };
function combined(a?: PermissionItem, b?: PermissionItem): string {
  const states = [a?.state ?? "unknown", b?.state ?? "unknown"];
  return states.includes("missing") ? "missing" : states.includes("unknown") ? "unknown" : states.every(s => s === "not-applicable") ? "not-applicable" : "granted";
}
export default function PermissionsPage() {
  const { data, loading } = permissions.use();
  const [acting, setActing] = useState(false);
  const busy = loading || acting;
  const { status } = connector.use();
  const currentLocale = locale.use();
  useEffect(() => {
    void refreshPermissions().catch(error => notify(String(error), true));
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
  async function act(id: string) {
    if (id === "codex" || id === "claude-code") {
      await openUrl("https://github.com/whzxc/agent-remote-control/blob/main/docs/" + (currentLocale === "zh-CN" ? "zh-CN/" : "") + "getting-started.md");
      return;
    }
    setActing(true);
    try {
      if (id === "login-start") await api("service", "POST", { enabled: true });
      else await api("permissions/request", "POST", { id });
      await refreshPermissions();
    } catch (e) { notify(String(e), true); }
    finally { setActing(false); }
  }
  function badge(state: string, system: boolean) {
    const ready = state === "granted";
    const key = state === "unknown" ? "permissionState.unknown" : ready ? (system ? "permissionsGranted" : "permissionState.granted") : system ? "permissionsNotGranted" : "permissionState.missing";
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
  return <div className="permissions-page">
    {data && <>
      {mac && <Group title={t("permissionsSystem")}><p className="permission-hint">{t("permissionsAppHint", {app: appName})}</p>{visible.filter(item => systemIds.includes(item.id)).map(row)}</Group>}
      <Group title={t("permissionsEnvironment")}>{visible.filter(item => !systemIds.includes(item.id)).map(row)}</Group>
    </>}
  </div>;
}
