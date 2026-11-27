import { Check, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { api } from "../../api";
import { readOnlyBrowser } from "../../browserMode";
import { controlSource } from "../../controlSources";
import { locale, t } from "../../i18n";
import { sourceDate } from "../../sourcePresentation";
import { connector, refreshConnector } from "../../state/connector";
import type { ControlSource } from "../../state/types";
import { IconButton } from "../kit/button";
import { Input } from "../kit/input";
import { Sensitive } from "../Sensitive";
import SourceIcon from "../SourceIcon";
import { ConfirmDialog, Notice } from "../ui";
import { useDialogCompletion } from "../ui/Dialog";
import { usePanelState } from "../ui/Panel";
import { useSubmittedDirty } from "../ui/useSubmittedDirty";
import { ConnectorCardView, type ConnectorFactItem } from "./ConnectorCardView";

export default function ConnectorCard({ source }: { source: ControlSource }) {
  const { status } = connector.use();
  const ingress = status?.ingresses.find((item) => item.id === source.ingressId);
  const grant = ingress?.oauth?.grants.find(
    (item) => item.id === source.credential.grantId,
  );
  const product = controlSource(source.product);
  const [removing, setRemoving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(source.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const draft = useSubmittedDirty(label, label !== source.label);
  usePanelState({ dirty: editing && draft.dirty, busy });
  const labelId = useId();
  const nameInput = useRef<HTMLInputElement>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);

  function finishEditing() {
    setEditing(false);
    setError("");
    requestAnimationFrame(() => editTrigger.current?.focus());
  }

  async function save() {
    if (busy) return;
    if (!label.trim()) {
      setError(t("fieldRequired"));
      nameInput.current?.focus();
      return;
    }
    if (label.trim() === source.label) {
      finishEditing();
      return;
    }
    draft.submit();
    setBusy(true);
    setError("");
    try {
      await api(`source/${source.id}`, "PUT", { label: label.trim() });
      await refreshConnector();
      finishEditing();
    } catch (e) {
      setError(String(e));
      nameInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  const completion = useDialogCompletion(() => setRemoving(false));
  async function remove() {
    setBusy(true);
    setError("");
    try {
      await api(`source/${source.id}/disconnect`, "POST");
      await refreshConnector();
      await completion.finish();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const toFacts = (rows: readonly (readonly [string, string | undefined])[]) =>
    rows
      .filter((row): row is readonly [string, string] => Boolean(row[1]))
      .map<ConnectorFactItem>(([factLabel, value]) => ({
        label: factLabel,
        value,
        renderedValue: <Sensitive>{value}</Sensitive>,
      }));

  const identity = toFacts([
    [t("platforms.product"), product?.displayName],
    [
      t("platforms.client"),
      grant?.clientName !== product?.displayName ? grant?.clientName : undefined,
    ],
    [t("platforms.email"), source.authorizationFacts?.email],
    [t("platforms.organization"), source.authorizationFacts?.orgName],
    [t("platforms.accountId"), source.authorizationFacts?.accountId],
  ]);

  const connection = toFacts([
    [t("platforms.connection"), ingress?.name ?? source.connectionName],
    [
      t("platforms.added"),
      source.createdAt
        ? new Date(source.createdAt).toLocaleString(locale.get(), {
            hour12: false,
          })
        : undefined,
    ],
  ]);

  const activity = toFacts([
    [
      t("source.authorizedAt"),
      grant?.connectedAt || source.connectedAt
        ? sourceDate(grant?.connectedAt || source.connectedAt)
        : undefined,
    ],
    [
      t("source.lastSeen"),
      source.lastSeenAt ? sourceDate(source.lastSeenAt) : undefined,
    ],
  ]);

  const facts =
    identity.length <= 1
      ? [[...identity, ...connection], activity]
      : [identity, connection, activity];

  const editForm = (
    <form
      className="min-w-0 flex-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <div className="flex items-center gap-1.5">
        <Input
          ref={nameInput}
          id={labelId}
          size="sm"
          aria-label={t("platforms.name")}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${labelId}-error` : undefined}
          autoFocus
          required
          value={label}
          maxLength={120}
          readOnly={busy}
          onChange={(event) => setLabel(event.target.value)}
        />
        <IconButton
          compact
          icon={Check}
          label={t("save")}
          type="submit"
          busy={busy}
        />
        <IconButton
          compact
          icon={X}
          label={t("cancel")}
          disabled={busy}
          onClick={finishEditing}
        />
      </div>
      {error && (
        <p
          id={`${labelId}-error`}
          className="mt-1 text-meta leading-4 text-destructive"
          role="alert"
        >
          {error}
        </p>
      )}
    </form>
  );

  return (
    <>
      <ConnectorCardView
        title={source.label}
        statusLabel={t(`source.state.${source.state}`)}
        connected={source.state === "connected"}
        icon={<SourceIcon platform={source.product} />}
        facts={facts}
        editing={editing}
        editForm={editForm}
        renameLabel={t("platforms.rename", { name: source.label })}
        removeLabel={t("platforms.remove", { name: source.label })}
        actionsDisabled={readOnlyBrowser || busy}
        renameButtonRef={editTrigger}
        onRename={() => {
          setLabel(source.label);
          setError("");
          setEditing(true);
        }}
        onRemove={() => {
          setError("");
          setRemoving(true);
        }}
      />
      {removing && (
        <ConfirmDialog
          layerId={completion.layerId}
          title={t("platforms.remove", { name: source.label })}
          busy={busy}
          onClose={() => setRemoving(false)}
          confirmLabel={t("remove")}
          onConfirm={remove}
        >
          <p>{t("platforms.removeConfirm")}</p>
          {error && <Notice>{error}</Notice>}
        </ConfirmDialog>
      )}
    </>
  );
}
