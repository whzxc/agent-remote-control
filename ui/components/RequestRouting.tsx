import { readOnlyBrowser } from "../browserMode";
import { useAppNow } from "../state/appEnvironment";
import { t } from "../i18n";
import type { RequestRouting as Routing } from "../state/requestRouting";
import { Button } from "./ui";

import { RoutingRow } from "./timeline/TaskPresentation";
import { useState } from "react";

export default function RequestRouting({ routing, source, busy, change, mode = "all", inline = false }: {
  mode?: "all" | "passive" | "actionable";
  inline?: boolean;
  routing?: Routing; source: string; busy: boolean;
  change: (action: "pause" | "resume" | "handoff") => Promise<void>;
}) {
  const now = useAppNow(routing?.state === "deferred" ? 1000 : null);
  const [action, setAction] = useState<"pause" | "resume" | "handoff">();
  if (!routing) return null;
  const seconds = Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000));
  const deferred = routing.state === "deferred";
  const paused = routing.state === "paused";
  const actionable = deferred || paused;
  if (mode === "passive" && actionable || mode === "actionable" && !actionable) return null;
  const act = (next: "pause" | "resume" | "handoff") => { setAction(next); void change(next).finally(() => setAction(undefined)); };
  const label = deferred ? t("routing.countdown", { source, seconds }) : t(paused ? "routing.paused" : routing.state === "not-routable" ? "routing.nextCheck" : "routing.routed", { source });
  // Announce state changes and the final five-second interval, never each tick.
  const announcement = deferred ? t(seconds <= 5 ? "routing.soon" : "routing.handing", { source }) : label;
  const row = <RoutingRow inline={inline}>
    {deferred && <span className="request-routing-status" data-actionable={actionable || undefined} aria-hidden="true">{label}</span>}<span className={deferred ? "sr-only" : "request-routing-status"} data-actionable={!deferred && actionable || undefined} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {actionable && <div className="actions" data-routing-controls>
      <Button variant="ghost" disabled={readOnlyBrowser || busy || !!action} busy={!!action && action !== "handoff"} onClick={() => act(paused ? "resume" : "pause")}>{t(paused ? "routing.resume" : "routing.pause")}</Button>
      <Button variant="secondary" disabled={readOnlyBrowser || busy || !!action} busy={action === "handoff"} onClick={() => act("handoff")}>{t("routing.handoff", { source })}</Button>
    </div>}
  </RoutingRow>;
  return !inline && actionable ? <div className="request-routing-stacked">{row}</div> : row;
}
