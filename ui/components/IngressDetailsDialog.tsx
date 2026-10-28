import { useState } from "react";
import { t } from "../i18n";
import { navigation } from "../state/navigation";
import { connector, ingressState } from "../state/connector";
import type { Ingress } from "../state/types";
import IngressConnection from "./IngressConnection";
import { Button, CopyField, Dialog, DialogClose, Status } from "./ui";

// Provider-specific connection forms remain available for existing advanced entries.
export default function IngressDetailsDialog({ ingress, onClose, onEdit }: {
  ingress: Ingress; onClose: () => void; onEdit: (ingress: Ingress) => void;
}) {
  const { status } = connector.use();
  const entry = status?.ingresses.find(i => i.id === ingress.id) ?? ingress;
  const [busy, setBusy] = useState(false);
  const state = ingressState(entry);
  const managed = ["relay", "local"].includes(entry.transport);
  return <Dialog title={<span className="ingress-dialog-title">{entry.name}<Status tone={state === "connectionError" ? "danger" : state === "connected" ? "success" : "neutral"}>{t(state)}</Status></span>}
    onClose={onClose} busy={busy} footer={<>
      <Button disabled={busy} onClick={() => { if (managed) { onClose(); navigation.set(old => ({ ...old, page: "overview", connectionsOpen: true })); } else onEdit(entry); }}>{t(managed ? "connect.manage" : "edit")}</Button><span className="spacer" />
      <DialogClose asChild><Button variant="primary" disabled={busy}>{t("done")}</Button></DialogClose>
    </>}>
    {managed ? <CopyField value={entry.url || t("connect.tryPrompt")} label={t(entry.url ? "connect.remoteLink" : "connect.tryClaude")} /> : <IngressConnection ingress={ingress} onBusy={setBusy} />}
  </Dialog>;
}
