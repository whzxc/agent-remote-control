import { readOnlyBrowser } from "../browserMode";
import { useAppNow } from "../state/appEnvironment";
import { t } from "../i18n";
import type { RequestRouting as Routing } from "../state/requestRouting";
import { Button } from "./ui";

export default function RequestRouting({ routing, source, busy, change }: {
  routing?: Routing; source: string; busy: boolean;
  change: (action: "pause" | "resume" | "handoff") => Promise<void>;
}) {
  const now = useAppNow(routing?.state === "deferred" ? 1000 : null);
  if (!routing) return null;
  const seconds = Math.max(0, Math.ceil(((routing.deferUntil ?? now) - now) / 1000));
  const deferred = routing.state === "deferred";
  const paused = routing.state === "paused";
  const label = deferred ? t("routing.countdown", { source, seconds }) : t(paused ? "routing.paused" : routing.state === "not-routable" ? "routing.nextCheck" : "routing.routed", { source });
  // Announce state changes and the final five-second interval, never each tick.
  const announcement = deferred ? t(seconds <= 5 ? "routing.soon" : "routing.handing", { source }) : label;
  return <div className="request-routing">
    {deferred && <span aria-hidden="true">{label}</span>}<span className={deferred ? "sr-only" : undefined} role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
    {(deferred || paused) && <div className="actions" data-routing-controls>
      <Button variant="ghost" disabled={readOnlyBrowser || busy} onClick={() => void change(paused ? "resume" : "pause")}>{t(paused ? "routing.resume" : "routing.pause")}</Button>
      <Button variant="secondary" disabled={readOnlyBrowser || busy} onClick={() => void change("handoff")}>{t("routing.handoff", { source })}</Button>
    </div>}
  </div>;
}
