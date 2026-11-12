import { useState } from "react";
import { t, locale } from "../i18n";
import { subscriptions, refreshSubscription } from "../state/subscriptions";
import { agents } from "../state/agents";
import type { Page } from "../state/navigation";
import QuotaBubble from "./QuotaBubble";
import { Gauge, RefreshCw } from "lucide-react";
import { SettingsDialog } from "../components/ui/Settings";
import { Button, Empty, IconButton, Loading, Notice } from "../components/ui";
export default function UsageOverview({ onNavigate, onClose }: { onNavigate: (page: Page) => void; onClose: () => void }) {
  locale.use();
  const { snapshot, error: subscriptionError } = subscriptions.use();
  const inventory = agents.use();
  const enabled = new Set(inventory.items.filter(agent => agent.installed && agent.enabled === true).map(agent => agent.agent));
  const providers = snapshot?.settings.enabled
    ? snapshot.providers.filter((p) => p.eligible && (p.agentIds?.length ? p.agentIds : [p.agentId]).some(agent => enabled.has(agent)))
    : [];
  const [dismissKey, setDismissKey] = useState(0);
  const [requesting, setRequesting] = useState(false), [error, setError] = useState("");
  async function refresh() {
    setRequesting(true); setError("");
    const results = await Promise.allSettled(providers.map(provider => refreshSubscription(provider.providerId)));
    const failures = results.flatMap(result => result.status === "rejected" ? [String(result.reason)] : []);
    setError(failures.join(" · "));
    setRequesting(false);
  }
  return (
    <SettingsDialog busy={requesting || providers.some(provider => provider.refreshing)} title={t("trayUsage")} onClose={onClose} actions={providers.length > 0 &&
      <IconButton icon={RefreshCw} label={t("usageRefresh")} busy={requesting || providers.some(provider => provider.refreshing)} onClick={() => void refresh()} />}>
    <section className="usage-overview" aria-label={t("trayUsage")}>
      <div
        className="usage-overview-scroll"
        onScroll={() => setDismissKey((k) => k + 1)}
      >
        <div className="usage-overview-content">
          {(error || subscriptionError) && <Notice>{error || subscriptionError}</Notice>}
          {!snapshot && !subscriptionError && <Loading />}
          {providers.map((provider) => (
              <QuotaBubble
                key={`${provider.providerId}:${dismissKey}`}
                provider={provider}
                refreshable={false}
              />
          ))}
          {snapshot && !providers.length && (
            <Empty icon={Gauge} inset={false}
              action={
                <Button onClick={() => onNavigate("settings")}>
                  {t("traySettings")}
                </Button>
              }
            >
              {t("trayEmpty")}
            </Empty>
          )}
        </div>
      </div>
    </section>
    </SettingsDialog>
  );
}
