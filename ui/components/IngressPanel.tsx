import { layerTrigger } from "../state/layers";
import Panel from "./ui/Panel";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { t } from "../i18n";
import { api } from "../api";
import { connector, refreshConnector } from "../state/connector";
import { tasks } from "../state/tasks";
import { ingressPanel, selectIngressPanel, sourcePanelId } from "../state/overviewPanels";
import type { LayerRect } from "./ui/layerFrame";
import IngressDialog from "./IngressDialog";
import SourcePanel from "./SourcePanel";
import SourcePlatformView from "./SourcePlatformView";
import { controlSourcePlatform } from "../controlSources";
import {  IconButton, Notice } from "./ui";
import { useDockOpening } from "./useDockOpening";

export default function IngressPanel({ onPanelFrame, expanded, onToggleWidth }: {
  onPanelFrame: (rect: LayerRect | null) => void; expanded: boolean; onToggleWidth: () => void;
}) {
  const focusTrigger = useRef(layerTrigger());
  const selected = ingressPanel.use()!, { status, sources, sourcesLoaded, error: connectorError } = connector.use();
  const tasksLoading = useSyncExternalStore(tasks.subscribe, () => tasks.get().loading);
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
  const widthControl = <IconButton icon={expanded ? Minimize2 : Maximize2} label={t(expanded ? "restorePanelWidth" : "expandPanelWidth")} aria-pressed={expanded} onClick={onToggleWidth} />;
  const fit = !connection?.editing;
  const pending = platform ? !sourcesLoaded && !connectorError : fit && !!source && tasksLoading;
  const cancelOpening = useCallback(() => {
    ingressPanel.set(current => current && sourcePanelId(current) === panelId ? undefined : current);
  }, [panelId]);
  const ready = useDockOpening(panelId, pending, selected.closing, cancelOpening);
  if (!ready) return null;
  return <Panel focusTrigger={focusTrigger.current} side="left" className="activity-panel" expanded={expanded} headerless title={title} busy={busy}
    viewKey={`${panelId}:${connection?.editing ? "edit" : "view"}`}
    onClose={() => ingressPanel.set(undefined)}
    returnFocus={platform ? `[data-source-platform="${CSS.escape(platform)}"] button` : `[data-source-node="${CSS.escape(client?.id ?? entry?.id ?? panelId)}"] button`} onPanelFrame={onPanelFrame}>
    <div className="side-panel-layer dialog-swap" key={`${panelId}:${connection?.editing ? "edit" : "view"}`}>
      {platform ? <SourcePlatformView platform={platform} widthControl={widthControl} onBusy={setBusy} /> : connection?.editing && entry ? <IngressDialog embedded ingress={entry} focusField={connection.field} onBusy={setBusy}
        onClose={() => selectIngressPanel(entry)} onRemoved={() => { if (ownsConnection()) ingressPanel.set(undefined); }}
        onSaved={ingress => { if (ownsConnection()) selectIngressPanel(ingress, { autoConnect: true }); }} /> : <>
        {source ? <SourcePanel key={source.id} source={source} widthControl={widthControl} /> : <Notice>{t("accounts.unidentified")}</Notice>}
        {error && <Notice>{error}</Notice>}
      </>}
    </div>
  </Panel>;
}
