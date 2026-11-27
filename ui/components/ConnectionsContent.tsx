import { Plus } from "lucide-react";
import { useState } from "react";
import { api } from "../api";
import { readOnlyBrowser } from "../browserMode";
import { t } from "../i18n";
import {
  connectionIcon,
  connectionKind,
  connectionProvider,
  isLocalSource,
  isPendingSource,
} from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import { navigation } from "../state/navigation";
import { openConnectionSetup } from "../state/onboarding";
import { usePrivacy } from "../state/privacy";
import { useRelays } from "../state/relay";
import type { Ingress } from "../state/types";
import { ConnectionCardView, ConnectionsListView } from "./ConnectionCardView";
import IngressDialog from "./IngressDialog";
import { Button } from "./kit/button";
import { PrivacyProvider } from "./kit/privacy";
import { RelaySettings } from "./RelaySettings";
import { useSensitiveText } from "./Sensitive";
import SourceIcon from "./SourceIcon";
import { ConfirmDialog, Notice } from "./ui";
import { useDialogCompletion } from "./ui/Dialog";
import Panel from "./ui/Panel";

export function ConnectionsPanel() {
  return (
    <Panel
      title={t("connections.title")}
      actions={
        <Button
          variant="primary"
          disabled={readOnlyBrowser}
          data-new-connection=""
          onClick={() => openConnectionSetup({ forConnections: true })}
        >
          <Plus
            size={15}
            strokeWidth={1.75}
            absoluteStrokeWidth
            aria-hidden="true"
          />
          {t("source.newConnection")}
        </Button>
      }
      returnFocus=".hub-connections"
      onClose={() =>
        navigation.set((old) => ({
          ...old,
          connectionsOpen: false,
          remoteConnectionId: undefined,
        }))
      }
    >
      <ConnectionsContent />
    </Panel>
  );
}

export default function ConnectionsContent() {
  const { status, sources, error: readError } = connector.use();
  const relays = useRelays();
  const hidden = usePrivacy();
  const protect = useSensitiveText();
  const [editing, setEditing] = useState<Ingress>();
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState<Ingress>();
  const [removeBusy, setRemoveBusy] = useState(false);
  const removal = useDialogCompletion(() => setRemoving(undefined));

  const entries = (status?.ingresses ?? []).filter(
    (entry) => entry.id !== "local-cli" || entry.transport !== "local",
  );
  const visible = sources.filter(
    (source) =>
      !isLocalSource(source) &&
      source.state !== "revoked" &&
      !isPendingSource(source, entries),
  );
  const removingRelay = relays.relays.find(
    (relay) => relay.ingressId === removing?.id,
  );
  const joined = removingRelay && !removingRelay.owner;

  async function removeConnection() {
    if (!removing) return;
    setRemoveBusy(true);
    setError("");
    try {
      if (joined) await api("relay/leave", "POST", { id: removingRelay.id });
      else await api(`ingress/${removing.id}`, "DELETE");
      await refreshConnector();
      await relays.refresh();
      await removal.finish();
    } catch (e) {
      setError(String(e));
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <PrivacyProvider hidden={hidden}>
      <ConnectionsListView
        readError={readError ? protect(readError) : undefined}
        actionError={
          error || relays.error
            ? protect(error || t("connect.readFailed"))
            : undefined
        }
      >
        {entries.map((connection) => {
          const relay = relays.relays.find(
            (item) => item.ingressId === connection.id,
          );
          const attached = visible.filter(
            (source) => source.ingressId === connection.id,
          );
          return (
            <ConnectionCardView
              key={connection.id}
              title={connection.name}
              online={connection.state === "ready"}
              statusLabel={t(
                connection.state === "ready"
                  ? "connect.online"
                  : "connect.offline",
              )}
              icon={connectionIcon(connection)}
              iconTone={
                connection.transport === "openai-tunnel" ? "command" : "accent"
              }
              sources={attached.map((source) => ({
                id: source.id,
                label: source.label,
                icon: <SourceIcon platform={source.product} />,
              }))}
              address={connection.url || undefined}
              copyAddressLabel={t("source.copyAddress")}
              providerLabel={t("source.provider")}
              providerValue={
                connection.transport === "relay"
                  ? "Cloudflare Workers"
                  : connectionProvider(connection)
              }
              methodLabel={t("connectionMethod")}
              methodValue={t(`source.kind.${connectionKind(connection)}`)}
              workerVersion={
                relay
                  ? `${t("setup.workerVersion")} · ${relay.workerVersion ?? "—"}`
                  : undefined
              }
              error={connection.error ? protect(connection.error) : undefined}
              canEdit={!["local", "relay"].includes(connection.transport)}
              editLabel={t("edit")}
              onEdit={() => setEditing(connection)}
              removeLabel={t(
                relay && !relay.owner ? "connect.leave" : "remove",
              )}
              onRemove={() => {
                setError("");
                setRemoving(connection);
              }}
              actionsDisabled={readOnlyBrowser}
              footer={
                relay ? (
                  <RelaySettings
                    relay={relay}
                    version={relays.version}
                    refresh={relays.refresh}
                  />
                ) : undefined
              }
            />
          );
        })}
      </ConnectionsListView>
      {removing && (
        <ConfirmDialog
          layerId={removal.layerId}
          title={t(
            joined ? "connect.confirm.leave" : "setup.removeConnection",
          )}
          busy={removeBusy}
          onClose={() => setRemoving(undefined)}
          confirmLabel={t(joined ? "connect.leave" : "remove")}
          onConfirm={removeConnection}
        >
          <p>
            {t("setup.removeConfirm", {
              name: removing.name,
              names:
                visible
                  .filter((source) => source.ingressId === removing.id)
                  .map((source) => source.label)
                  .join(", ") || t("source.unused"),
            })}
          </p>
          {error && <Notice>{error}</Notice>}
        </ConfirmDialog>
      )}
      {editing && (
        <IngressDialog
          ingress={editing}
          onClose={() => setEditing(undefined)}
          onRemoved={() => setEditing(undefined)}
          onSaved={(entry) => {
            void api(`ingress/${entry.id}/start`, "POST")
              .then(refreshConnector)
              .catch((e) => setError(String(e)));
          }}
        />
      )}
    </PrivacyProvider>
  );
}
