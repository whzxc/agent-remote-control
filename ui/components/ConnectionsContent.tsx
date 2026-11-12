import { useDialogCompletion } from "./ui/Dialog";
import WorkspacePanel from "./WorkspacePanel";
import { readOnlyBrowser } from "../browserMode";
import { Fragment, useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../api";
import { t } from "../i18n";
import { connector, refreshConnector } from "../state/connector";
import { useRelays } from "../state/relay";
import { navigation } from "../state/navigation";
import { openConnectionSetup } from "../state/onboarding";
import { connectionIcon, connectionKind, connectionProvider, isLocalSource, isPendingSource } from "../sourcePresentation";
import type { Ingress } from "../state/types";
import IngressDialog from "./IngressDialog";
import SourceIcon from "./SourceIcon";
import { RelaySettings } from "./RelaySettings";
import { Button, CopyField, Dialog, Icon, IconButton, Notice, Status, Tile } from "./ui";
import { Card, CardContent, CardHeader } from "./ui/card";

export function ConnectionsDialog() {
  return <WorkspacePanel title={t("connections.title")} width={680}
    actions={<Button variant="primary" disabled={readOnlyBrowser} data-new-connection onClick={() => openConnectionSetup()}><Icon icon={Plus} />{t("source.newConnection")}</Button>}
    returnFocus=".hub-connections" onClose={() => navigation.set(old => ({ ...old, connectionsOpen: false, remoteConnectionId: undefined }))}>
    <ConnectionsContent />
  </WorkspacePanel>;
}

export default function ConnectionsContent() {
  const { status, sources, error: readError } = connector.use(), relays = useRelays();
  const [editing, setEditing] = useState<Ingress>(), [error, setError] = useState("");
  const [removing, setRemoving] = useState<Ingress>(), [removeBusy, setRemoveBusy] = useState(false);
  const removal = useDialogCompletion(() => setRemoving(undefined));
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
      await refreshConnector(); await relays.refresh(); await removal.finish();
    } catch (e) { setError(String(e)); } finally { setRemoveBusy(false); }
  }
  return <div className="connections-content">
    {readError && <Notice>{readError}</Notice>}
    {entries.map(connection => {
      const relay = relays.relays.find(r => r.ingressId === connection.id);
      const attached = visible.filter(s => s.ingressId === connection.id);
      return <Card key={connection.id} asChild className="min-w-0"><section aria-label={connection.name}>
        <CardHeader className="grid-rows-1 gap-0"><div className="connection-card-heading">
          <Tile icon={connectionIcon(connection)} className={connection.transport === "openai-tunnel" ? "connection-tunnel" : "connection-relay"} />
          <div className="connection-card-identity"><h3>{connection.name}</h3><div className="connection-meta">
            <Status tone={connection.state === "ready" ? "success" : "neutral"}>{t(connection.state === "ready" ? "connect.online" : "connect.offline")}</Status>
            {attached.map(source => <Fragment key={source.id}><span aria-hidden="true"> · </span><span className="connection-source-meta"><SourceIcon platform={source.product} /><span>{source.label}</span></span></Fragment>)}
          </div></div>
          <div className="actions">
            {!["local", "relay"].includes(connection.transport) && <IconButton disabled={readOnlyBrowser} icon={Pencil} label={t("edit")} onClick={() => setEditing(connection)} />}
            <IconButton disabled={readOnlyBrowser} icon={Trash2} label={t(relay && !relay.owner ? "connect.leave" : "remove")} onClick={() => { setError(""); setRemoving(connection); }} />
          </div>
        </div></CardHeader>
        <CardContent className="connection-card-content">
          {connection.url && <CopyField value={connection.url} label={t("source.copyAddress")} />}
          <dl className="connection-facts">
            <div><dt>{t("source.provider")}</dt><dd>{connection.transport === "relay" ? "Cloudflare Workers" : connectionProvider(connection)}</dd>
              {relay && <div className="connection-version">{t("setup.workerVersion")} · {relay.workerVersion ?? "—"}</div>}
            </div>
            <div><dt>{t("connectionMethod")}</dt><dd>{t(`source.kind.${connectionKind(connection)}`)}</dd></div>
          </dl>
          {connection.error && <Notice>{connection.error}</Notice>}
          {relay && <RelaySettings relay={relay} version={relays.version} refresh={relays.refresh} />}
        </CardContent>
      </section></Card>;
    })}
    {(error || relays.error) && <Notice>{error || t("connect.readFailed")}</Notice>}
    {removing && <Dialog layerId={removal.layerId} size="s" title={t(joined ? "connect.confirm.leave" : "setup.removeConnection")} busy={removeBusy} onClose={() => setRemoving(undefined)} footer={<><Button onClick={() => setRemoving(undefined)}>{t("cancel")}</Button><Button variant="danger" busy={removeBusy} onClick={() => void removeConnection()}>{t(joined ? "connect.leave" : "remove")}</Button></>}>
      <p>{t("setup.removeConfirm", { name: removing.name, names: visible.filter(s => s.ingressId === removing.id).map(s => s.label).join(", ") || t("source.unused") })}</p>{error && <Notice>{error}</Notice>}
    </Dialog>}
    {editing && <IngressDialog ingress={editing} onClose={() => setEditing(undefined)} onRemoved={() => setEditing(undefined)} onSaved={entry => {
      void api(`ingress/${entry.id}/start`, "POST").then(refreshConnector).catch(e => setError(String(e)));
    }} />}
  </div>;
}
