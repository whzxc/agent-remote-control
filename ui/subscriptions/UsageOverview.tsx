import { useEffect, useRef, useState } from "react";
import { Image, Settings } from "lucide-react";
import { t, locale } from "../i18n";
import { isDesktop } from "../platform";
import { subscriptions } from "../state/subscriptions";
import type { Page } from "../state/navigation";
import QuotaBubble from "./QuotaBubble";
import { brandIcon } from "./presentation";
import { copyShareCard } from "./shareCard";
import { Button, Empty, Icon, Loading, Notice } from "../components/ui";
export default function UsageOverview({ onNavigate }: { onNavigate: (page: Page) => void }) {
  locale.use();
  const { snapshot, error: subscriptionError } = subscriptions.use();
  const providers = snapshot?.settings.enabled
    ? snapshot.providers.filter((p) => p.selected && p.eligible)
    : [];
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [copied, setCopied] = useState(false),
    [dismissKey, setDismissKey] = useState(0);
  const cards = useRef(new Map<string, HTMLElement>());
  async function share(id: string) {
    setError("");
    setCopied(false);
    setBusy(true);
    try {
      const card = cards.current.get(id),
        provider = providers.find((p) => p.providerId === id);
      if (!card || !provider) throw new Error(t("trayEmpty"));
      await copyShareCard(card, brandIcon(provider.agentId));
      setCopied(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 4000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <section className="usage-overview" aria-label={t("trayUsage")}>
      <div
        className="usage-overview-scroll"
        onScroll={() => setDismissKey((k) => k + 1)}
      >
        <div className="usage-overview-content">
          {(error || subscriptionError) && (
            <Notice>{error || subscriptionError}</Notice>
          )}
          {copied && (
            <Notice tone="success">{t("trayScreenshotCopied")}</Notice>
          )}
          {!snapshot && !subscriptionError && <Loading />}
          {providers.map((provider) => (
            <div
              key={provider.providerId}
              ref={(el) => {
                if (el) cards.current.set(provider.providerId, el);
                else cards.current.delete(provider.providerId);
              }}
              className="usage-provider-card"
            >
              <QuotaBubble
                key={`${provider.providerId}:${dismissKey}`}
                provider={provider}
                detailPlacement="left"
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
      <footer className="usage-overview-actions">
        <Button variant="ghost" onClick={() => onNavigate("settings")}>
          <Icon icon={Settings} /> {t("traySettings")}
        </Button>
        {providers.map((provider) => (
          <Button key={provider.providerId} variant="ghost"
            disabled={!isDesktop || busy} onClick={() => void share(provider.providerId)}>
            <Icon icon={Image} /> {t("trayShareScreenshot")} · {provider.name}
          </Button>
        ))}
      </footer>
    </section>
  );
}
