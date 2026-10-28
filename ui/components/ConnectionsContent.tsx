import { useState } from "react";
import { Pencil, Settings, Trash2 } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { connector, refreshConnector } from "../state/connector";
import { navigation } from "../state/navigation";
import { openConnectionSetup } from "../state/onboarding";
import { useRelays } from "../state/relay";
import { connectionIcon, connectionKind, connectionProvider, isLocalSource, isPendingSource } from "../sourcePresentation";
import type { Ingress } from "../state/types";
import IngressDialog from "./IngressDialog";
import SourceIcon from "./SourceIcon";
import { RelaySettings } from "./RelaySettings";
import { Button, CopyField, Dialog, Icon, IconButton, Notice, Status, Tooltip } from "./ui";
import { Card, CardContent, CardHeader } from "./ui/card";

export default function ConnectionsContent() {
  const { status, sources, error: readError } = connector.use(), relays = useRelays();
  const [editing, setEditing] = useState<Ingress>(), [error, setError] = useState("");
  const [removing, setRemoving] = useState<Ingress>(), [removeBusy, setRemoveBusy] = useState(false);
  const entries = (status?.ingresses ?? []).filter(entry => entry.id !== "local-cli" || entry.transport !== "local");
  const visible = sources.filter(s => !isLocalSource(s) && s.state !== "revoked" && !isPendingSource(s, entries));
  const removingRelay = relays.relays.find(r => r.ingressId === removing?.id);
  const joined = removingRelay && !removingRelay.owner;
  async function removeConnection() {
    if (!removing) return;
    setRemoveBusy(true); setError("");
    try {
      if (joined) await api("relay/leave", "POST", { id: removingRelay.id });
      else await api(`ingress/${removing.id}`, "DELETE");
      await refreshConnector(); await relays.refresh(); setRemoving(undefined);
    } catch (e) { setError(String(e)); } finally { setRemoveBusy(false); }
  }
  return <div className="grid min-w-0 gap-4">
    {readError && <Notice>{readError}</Notice>}
    <Button className="justify-self-start" data-new-connection variant="primary" onClick={() => openConnectionSetup()}>{t("source.newConnection")}</Button>
    {entries.map(connection => {
      const relay = relays.relays.find(r => r.ingressId === connection.id);
      const attached = visible.filter(s => s.ingressId === connection.id);
      return <Card key={connection.id} asChild className="min-w-0 gap-4 border-solid border-border py-4 shadow-none"><section aria-label={connection.name}>
        <CardHeader className="px-4"><div className="flex min-w-0 flex-wrap items-center gap-2">
          <Icon icon={connectionIcon(connection)} size={20} />
          <h3 className="min-w-0 flex-1 break-words">{connection.name}</h3>
          <Status tone={connection.state === "ready" ? "success" : "neutral"}>{t(connection.state === "ready" ? "connect.online" : "connect.offline")}</Status>
          <IconButton icon={Trash2} label={t(relay && !relay.owner ? "connect.leave" : "remove")} onClick={() => { setError(""); setRemoving(connection); }} />
          {!["local", "relay"].includes(connection.transport) && <IconButton icon={Pencil} label={t("edit")} onClick={() => setEditing(connection)} />}
          {relay?.owner && <IconButton icon={Settings} label={t("setup.hostingLink")} onClick={() => navigation.set(old => ({ ...old, page: "settings", settingsExtras: true, connectionsOpen: false }))} />}
        </div></CardHeader>
        <CardContent className="grid min-w-0 gap-4 px-4">
          {connection.url && <CopyField value={connection.url} label={t("source.copyAddress")} />}
          <dl className="m-0 grid grid-cols-2 gap-3 text-sm">
            <div className="min-w-0"><dt className="text-muted-foreground">{t("source.provider")}</dt><dd className="m-0 break-words">{connection.transport === "relay" ? "Cloudflare Workers" : connectionProvider(connection)}</dd></div>
            <div className="min-w-0"><dt className="text-muted-foreground">{t("connectionMethod")}</dt><dd className="m-0">{t(`source.kind.${connectionKind(connection)}`)}</dd></div>
            {relay && <div><dt className="text-muted-foreground">{t("setup.workerVersion")}</dt><dd className="m-0">{relay.workerVersion ?? "—"}</dd></div>}
          </dl>
          {attached.length > 0 && <div className="flex flex-wrap items-center -space-x-2 gap-y-1" role="group" aria-label={t("source.count", { count: attached.length })}>
            {attached.map(source => <Tooltip key={source.id} text={source.label}><span tabIndex={0} role="img" aria-label={source.label} className="relative flex size-8 shrink-0 hover:z-10 focus:z-10 items-center justify-center rounded-full border border-border bg-card [&_.source-icon]:size-5 [&_.source-icon_svg]:size-5"><SourceIcon platform={source.product} /></span></Tooltip>)}
          </div>}
          {connection.error && <Notice>{connection.error}</Notice>}
          {relay && <RelaySettings relay={relay} version={relays.version} refresh={relays.refresh} />}
        </CardContent>
      </section></Card>;
    })}
    {(error || relays.error) && <Notice>{error || t("connect.readFailed")}</Notice>}
    {removing && <Dialog centered title={t(joined ? "connect.confirm.leave" : "setup.removeConnection")} width={440} busy={removeBusy} onClose={() => setRemoving(undefined)} footer={<><Button disabled={removeBusy} onClick={() => setRemoving(undefined)}>{t("cancel")}</Button><Button variant="danger" busy={removeBusy} onClick={() => void removeConnection()}>{t(joined ? "connect.leave" : "remove")}</Button></>}>
      <p>{t("setup.removeConfirm", { name: removing.name, names: visible.filter(s => s.ingressId === removing.id).map(s => s.label).join(", ") || t("source.unused") })}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
    {editing && <IngressDialog ingress={editing} onClose={() => setEditing(undefined)} onRemoved={() => setEditing(undefined)} onSaved={entry => {
      setEditing(undefined); void api(`ingress/${entry.id}/start`, "POST").then(refreshConnector).catch(e => setError(String(e)));
    }} />}
  </div>;
}
