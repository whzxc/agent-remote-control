import { useState } from "react";
import { t, locale } from "../i18n";
import { subscriptions } from "../state/subscriptions";
import type { Page } from "../state/navigation";
import QuotaBubble from "./QuotaBubble";
import { Button, Empty, Loading, Notice } from "../components/ui";
export default function UsageOverview({ onNavigate }: { onNavigate: (page: Page) => void }) {
  locale.use();
  const { snapshot, error: subscriptionError } = subscriptions.use();
  const providers = snapshot?.settings.enabled
    ? snapshot.providers.filter((p) => p.eligible)
    : [];
  const [dismissKey, setDismissKey] = useState(0);
  return (
    <section className="usage-overview" aria-label={t("trayUsage")}>
      <div
        className="usage-overview-scroll"
        onScroll={() => setDismissKey((k) => k + 1)}
      >
        <div className="usage-overview-content">
          {subscriptionError && <Notice>{subscriptionError}</Notice>}
          {!snapshot && !subscriptionError && <Loading />}
          {providers.map((provider) => (
            <div
              key={provider.providerId}
              className="usage-provider-card"
            >
              <QuotaBubble
                key={`${provider.providerId}:${dismissKey}`}
                provider={provider}
              />
            </div>
          ))}
          {snapshot && !providers.length && (
            <Empty
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
  );
}
