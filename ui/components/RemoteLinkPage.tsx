import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { connector, refreshConnector } from "../state/connector";
import { navigation } from "../state/navigation";
import { onboarding, openConnectionSetup, connectionSwitch, connectionSetup } from "../state/onboarding";
import { useRelays } from "../state/relay";
import { connectionIcon, connectionKind, connectionProvider, isLocalSource, isPendingSource } from "../sourcePresentation";
import type { Ingress } from "../state/types";
import IngressDialog from "./IngressDialog";
import ChangeConnection from "./ChangeConnection";
import AddConnection from "./AddConnection";
import Onboarding from "./Onboarding";
import { Sensitive } from "./Sensitive";
import { RelaySettings } from "./RelaySettings";
import { Button, CopyField, Dialog, HoverScope, Icon, Notice, Status } from "./ui";

export default function RemoteLinkPage() {
  const { status, sources, error: readError } = connector.use(), nav = navigation.use(), relays = useRelays();
  const switching = connectionSwitch.use(), newConnection = connectionSetup.use(), flow = onboarding.use();
  const [editing, setEditing] = useState<Ingress>(), [error, setError] = useState("");
  const [removing, setRemoving] = useState(false), [removeBusy, setRemoveBusy] = useState(false);
  const previous = useRef<string | undefined>(undefined);
  const entries = (status?.ingresses ?? []).filter(entry => entry.id !== "local-cli" || entry.transport !== "local");
  const visible = sources.filter(s => !isLocalSource(s) && s.state !== "revoked" && !isPendingSource(s, entries));
  const connection = entries.find(i => i.id === nav.remoteConnectionId);
  const selectedRelay = relays.relays.find(r => r.ingressId === connection?.id);
  const affected = visible.filter(s => s.ingressId === connection?.id);
  const joined = selectedRelay && !selectedRelay.owner;
  useEffect(() => {
    const current = nav.remoteConnectionId;
    const prior = previous.current;
    const frame = requestAnimationFrame(() => {
      const target = !current && prior ? document.querySelector<HTMLElement>(`[data-remote-row="${CSS.escape(prior)}"]`)
        : current ? document.querySelector<HTMLElement>(".sheet-header h1") : null;
      target?.focus({ preventScroll: true });
    });
    previous.current = current;
    return () => cancelAnimationFrame(frame);
  }, [nav.remoteConnectionId]);
  async function removeConnection() {
    if (!connection) return;
    setRemoveBusy(true); setError("");
    try {
      if (joined) await api("relay/leave", "POST", { id: selectedRelay.id });
      else await api(`ingress/${connection.id}`, "DELETE");
      await refreshConnector(); await relays.refresh(); setRemoving(false);
      navigation.set(old => ({ ...old, remoteConnectionId: undefined }));
    } catch (e) { setError(String(e)); } finally { setRemoveBusy(false); }
  }
  return <div className="remote-link-page">
    {readError && <Notice>{readError}</Notice>}
    {connection ? <div className="connection-detail">
      <div className="connection-detail-heading"><span className="connection-detail-icon"><Icon icon={connectionIcon(connection)} size={20} /></span><div><h2>{connection.name}</h2><p>{connectionProvider(connection)}{selectedRelay?.owner ? ` · ${t("setup.hostedHere")}` : ""}</p></div><Status tone={connection.state === "ready" ? "success" : "neutral"}>{t(connection.state === "ready" ? "connect.online" : "connect.offline")}</Status></div>
      {connection.url && <CopyField value={connection.url} label={t("source.copyAddress")} />}
      <dl className="source-facts connection-provider-facts"><div><dt>{t("source.provider")}</dt><dd>{connection.transport === "relay" ? "Cloudflare Workers" : connectionProvider(connection)}</dd></div><div><dt>{t("connectionMethod")}</dt><dd>{t(`source.kind.${connectionKind(connection)}`)}</dd></div>{selectedRelay && <div><dt>{t("setup.workerVersion")}</dt><dd>{selectedRelay.workerVersion ?? "—"}</dd></div>}</dl>
      {connection.error && <Notice>{connection.error}</Notice>}
      {selectedRelay && <RelaySettings relay={selectedRelay} version={relays.version} refresh={relays.refresh} />}
      {!["local", "relay"].includes(connection.transport) && <Button onClick={() => setEditing(connection)}>{t("edit")}</Button>}
      {selectedRelay?.owner && <Button className="connection-hosting-link" variant="ghost" onClick={() => navigation.set(old => ({ ...old, page: "settings", settingsExtras: true }))}>{t("setup.hostingLink")}<Icon icon={ChevronRight} /></Button>}
      <div className="connection-remove"><div><strong>{t(joined ? "connect.leave" : "setup.removeConnection")}</strong><p>{t("setup.removeAffected", { names: affected.map(s => s.label).join(", ") || t("source.unused") })}</p></div><Button variant="danger-outline" onClick={() => { setError(""); setRemoving(true); }}>{t(joined ? "connect.leave" : "remove")}</Button></div>
    </div> : <>
      <section className="connection-list"><div className="source-section-heading"><Button data-new-connection variant="primary" onClick={() => openConnectionSetup()}>{t("source.newConnection")}</Button></div>
        <HoverScope>{entries.map(ingress => {
          const count = visible.filter(s => s.ingressId === ingress.id).length;
          return <Button key={ingress.id} variant="ghost" className="source-list-row connection-list-row" data-hover-target={ingress.id} data-remote-row={ingress.id} onClick={() => navigation.set(old => ({ ...old, remoteConnectionId: ingress.id }))}>
            <Icon icon={connectionIcon(ingress)} size={20} /><span className="connection-list-copy"><strong>{ingress.name}</strong>{ingress.url ? <Sensitive>{ingress.url}</Sensitive> : connectionProvider(ingress)}</span>
            <span className="muted">{t(count ? "source.count" : "source.unused", { count })}</span><Status tone={ingress.state === "ready" ? "success" : "neutral"}>{t(ingress.state === "ready" ? "connect.online" : "connect.offline")}</Status><Icon icon={ChevronRight} />
          </Button>;
        })}</HoverScope>
      </section>
    </>}
    {(error || relays.error) && <Notice>{error || t("connect.readFailed")}</Notice>}
    {removing && connection && <Dialog centered title={t(joined ? "connect.confirm.leave" : "setup.removeConnection")} width={440} busy={removeBusy} onClose={() => setRemoving(false)} footer={<><Button disabled={removeBusy} onClick={() => setRemoving(false)}>{t("cancel")}</Button><Button variant="danger" busy={removeBusy} onClick={() => void removeConnection()}>{t(joined ? "connect.leave" : "remove")}</Button></>}>
      <p>{t("setup.removeConfirm", { name: connection.name, names: affected.map(s => s.label).join(", ") || t("source.unused") })}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
    {switching && <ChangeConnection />}
    {flow && <Onboarding returnFocus="[data-add-source], .hub-source" />}
    {newConnection && <AddConnection options={newConnection} returnFocus="[data-new-connection], [data-add-source], .hub-source" onClose={() => connectionSetup.set(undefined)} onAdded={id => {
      if (newConnection.forSwitch) connectionSwitch.set(old => old && { ...old, ingressId: id });
      if (newConnection.forSource) onboarding.set(old => old?.step === "connection" ? { ...old, step: "address", ingressId: id, baseline: (connector.get().status?.ingresses.find(i => i.id === id)?.oauth?.pending ?? []).map(p => p.id) } : old);
      connectionSetup.set(undefined);
    }} />}
    {editing && <IngressDialog ingress={editing} onClose={() => setEditing(undefined)} onRemoved={() => { setEditing(undefined); navigation.set(old => ({ ...old, remoteConnectionId: undefined })); }} onSaved={entry => {
      setEditing(undefined); void api(`ingress/${entry.id}/start`, "POST").then(refreshConnector).catch(e => setError(String(e)));
    }} />}
  </div>;
}
