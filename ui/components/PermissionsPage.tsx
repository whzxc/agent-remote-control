import { useEffect, useState } from "react";
import { api } from "../api";
import { t } from "../i18n";
import { isDesktop } from "../platform";
import { Button, Group, Row } from "./ui";
import { notify } from "../state/connector";

type Item = { id: string; state: string; process: string; executable?: string; grantTarget?: string };
export type Readiness = { items: Item[]; observedAt: string };
export default function PermissionsPage() {
  const [data, setData] = useState<Readiness>();
  const [busy, setBusy] = useState(false);
  const refresh = async () => {
    setBusy(true);
    try { setData(await api<Readiness>("permissions")); }
    catch (error) { notify(String(error), true); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener("focus", focus);
    let dispose: (() => void) | undefined;
    let closed = false;
    if (isDesktop) void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      const off = await getCurrentWindow().onFocusChanged(({ payload }) => { if (payload) focus(); });
      if (closed) off(); else dispose = off;
    });
    return () => { closed = true; dispose?.(); window.removeEventListener("focus", focus); };
  }, []);
  return <Group title={t("permissionsTitle")}>
    <Button disabled={busy} onClick={() => void refresh()}>{t("permissionsRefresh")}</Button>
    {data && <p className="permission-observed"><time dateTime={data.observedAt}>{new Date(data.observedAt).toLocaleTimeString()}</time></p>}
    {!data && <p role="status">{t("permissionsLoading")}</p>}
    {data?.items.map(item => <Row key={item.id} title={item.id.startsWith("ingress:") ? item.id : t("permission." + item.id)}
      description={<>{t(item.id.startsWith("ingress:") ? "permissionUse.ingress" : "permissionUse." + item.id)} {item.grantTarget && <code title={item.grantTarget}>{item.grantTarget.split("/").pop()}</code>}</>}>
      <div className="permission-actions"><span role="status">{t("permissionState." + item.state)}</span>
      {isDesktop && navigator.platform.toLowerCase().includes("mac") && ["accessibility", "screen-recording", "full-disk-access", "command-full-disk-access", "notifications", "login-start"].includes(item.id) && item.state !== "not-applicable" &&
        <Button disabled={busy} onClick={() => {
          setBusy(true);
          void api("permissions/request", "POST", {id:item.id}).then(refresh)
            .catch(e => notify(String(e), true)).finally(() => setBusy(false));
        }}>{t("permissionsGrant")}</Button>}
      </div>
    </Row>)}
  </Group>;
}
