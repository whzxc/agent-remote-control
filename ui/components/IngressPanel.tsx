import { useReducedMotion } from "../state/appEnvironment";
import { useEffect, useRef, useState } from "react";
import { motion } from "motion/react";
import { Maximize2, Minimize2 } from "lucide-react";
import { t } from "../i18n";
import { api } from "../api";
import { connector, refreshConnector } from "../state/connector";
import { ingressPanel, selectIngressPanel, sourcePanelId } from "../state/overviewPanels";
import type { SurfaceRect } from "../motion/surface";
import IngressDialog from "./IngressDialog";
import SourcePanel from "./SourcePanel";
import SourcePlatformView from "./SourcePlatformView";
import { controlSourcePlatform } from "../controlSources";
import { Dialog, IconButton, Notice } from "./ui";

export default function IngressPanel({ onPanelFrame, width, expanded, onToggleWidth, dockRect }: {
  onPanelFrame: (rect: SurfaceRect | null) => void; width?: number; dockRect?: SurfaceRect; expanded: boolean; onToggleWidth: () => void;
}) {
  const selected = ingressPanel.use()!, { status, sources } = connector.use();
  const connection = 'ingress' in selected ? selected : undefined;
  const platform = 'platform' in selected ? selected.platform : undefined;
  const entry = connection && (status?.ingresses.find(i => i.id === connection.ingress.id) ?? connection.ingress);
  const source = connection && (sources.find(s => s.id === connection.client?.id) ?? sources.find(s => s.ingressId === entry?.id && s.state !== "revoked"));
  const client = source ? { id: source.id, name: source.label, source: source.product } : connection?.client;
  const panelId = sourcePanelId(selected);
  const title = platform ? controlSourcePlatform(platform).displayName : client?.name ?? entry?.name ?? t('source.title');
  const ownsConnection = () => {
    const current = ingressPanel.get();
    return !!current && 'ingress' in current && current.ingress.id === entry?.id;
  };
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const currentId = useRef(entry?.id); currentId.current = entry?.id;
  useEffect(() => { setError(""); setBusy(false); }, [panelId, entry?.id]);
  useEffect(() => {
    if (!entry || !connection?.autoConnect) return;
    ingressPanel.set(old => old && 'ingress' in old && old.ingress.id === entry.id ? { ...old, autoConnect: false } : old);
    setBusy(true);
    void api(`ingress/${entry.id}/start`, "POST").then(refreshConnector)
      .catch(() => { if (currentId.current === entry.id) setError(t("connect.actionFailed")); })
      .finally(() => { if (currentId.current === entry.id) setBusy(false); });
  }, [entry?.id, connection?.autoConnect]);
  const wasEditing = useRef(connection?.editing);
  useEffect(() => {
    const returning = wasEditing.current && !connection?.editing;
    wasEditing.current = connection?.editing;
    if (!returning) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLElement>("[data-change-connection]")?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [connection?.editing]);
  const reduced = useReducedMotion();
  const widthControl = !dockRect && <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")} aria-pressed={expanded} onClick={onToggleWidth} />;
  return <Dialog width={width} dockRect={dockRect} dock="left" expanded={expanded} headerless title={title} busy={busy}
    originKey={panelId} closeRequested={selected.closing}
    onCloseStart={() => ingressPanel.set(old => old && sourcePanelId(old) === panelId ? { ...old, closing: true } : old)}
    onClose={() => { const current = ingressPanel.get(); if (current && sourcePanelId(current) === panelId && current.closing) ingressPanel.set(undefined); }}
    returnFocus={platform ? `[data-source-platform="${CSS.escape(platform)}"] button` : `[data-source-node="${CSS.escape(client?.id ?? entry?.id ?? panelId)}"] button`} onPanelFrame={onPanelFrame}>
    <motion.div className="side-panel-layer" key={`${panelId}:${connection?.editing ? "edit" : "view"}`}
      initial={{ opacity: reduced ? 1 : 0, x: reduced ? 0 : connection?.editing ? -12 : 12 }} animate={{ opacity: 1, x: 0 }} transition={{ duration: reduced ? 0 : 0.16 }}>
      {platform ? <SourcePlatformView platform={platform} widthControl={widthControl} onBusy={setBusy} /> : connection?.editing && entry ? <IngressDialog embedded ingress={entry} focusField={connection.field} onBusy={setBusy}
        onClose={() => selectIngressPanel(entry)} onRemoved={() => { if (ownsConnection()) ingressPanel.set(undefined); }}
        onSaved={ingress => { if (ownsConnection()) selectIngressPanel(ingress, { autoConnect: true }); }} /> : <>
        {source ? <SourcePanel key={source.id} source={source} widthControl={widthControl} /> : <Notice>{t("accounts.unidentified")}</Notice>}
        {error && <Notice>{error}</Notice>}
      </>}
    </motion.div>
  </Dialog>;
}
