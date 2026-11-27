import { Plus } from "lucide-react";
import { readOnlyBrowser } from "../browserMode";
import { controlSources, sourcePlatforms } from "../controlSources";
import { t } from "../i18n";
import { platformSources } from "../sourcePresentation";
import { connector, refreshConnector } from "../state/connector";
import { navigation } from "../state/navigation";
import { openOnboarding } from "../state/onboarding";
import { PlatformsPageView } from "./connectivity/PlatformsPageView";
import { Alert } from "./kit/alert";
import { Button } from "./kit/button";
import { Empty } from "./kit/empty";
import { Loading } from "./kit/spinner";
import ConnectorCard from "./objects/ConnectorCard";
import SourceIcon from "./SourceIcon";
import { Menu } from "./ui";
import { EntityInventory, EntitySection } from "./ui/EntityInventory";

export function PlatformConnectors({ platform }: { platform: string }) {
  const { sources, status, sourcesLoaded, error } = connector.use();
  const entries = platformSources(sources, status?.ingresses ?? [], platform);
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-3"
      aria-busy={!sourcesLoaded && !error ? true : undefined}
    >
      {error && (
        <Alert
          tone="danger"
          action={
            <Button
              size="sm"
              onClick={() => void refreshConnector().catch(() => {})}
            >
              {t("retry")}
            </Button>
          }
        >
          {error}
        </Alert>
      )}
      {entries.length > 0
        ? entries.map((source) => (
            <ConnectorCard key={source.id} source={source} />
          ))
        : !error &&
          (sourcesLoaded ? (
            <Empty className="flex-1">{t("platforms.empty")}</Empty>
          ) : (
            <Loading />
          ))}
    </div>
  );
}

export default function PlatformsPage() {
  const nav = navigation.use();
  const { sources, status, sourcesLoaded, error } = connector.use();
  const platform =
    sourcePlatforms.find((item) => item.id === nav.platformId) ??
    sourcePlatforms[0];
  const platformLabel =
    platform.id === "custom" ? t("platforms.other") : platform.displayName;
  const products = controlSources.filter(
    (source) =>
      source.platform === platform.id &&
      (source.curated || source.id === "grok-bot" || source.id === "custom"),
  );
  const entries = platformSources(sources, status?.ingresses ?? [], platform.id);

  const addButton = (
    <Button
      variant="primary"
      disabled={readOnlyBrowser}
      data-platform-add=""
      onClick={
        products.length === 1
          ? () => openOnboarding("connection", { source: products[0].id })
          : undefined
      }
    >
      <Plus size={15} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
      {t("addControlSource")}
    </Button>
  );

  const addAction =
    products.length === 1 ? (
      addButton
    ) : (
      <Menu
        trigger={addButton}
        label={t("addControlSource")}
        items={products.map((product) => ({
          label: t("setup.addProduct", { name: product.displayName }),
          action: () => openOnboarding("connection", { source: product.id }),
        }))}
      />
    );

  return (
    <EntityInventory className="flex min-h-0 flex-1">
      <PlatformsPageView
        platforms={sourcePlatforms.map((item) => ({
          id: item.id,
          label: item.id === "custom" ? t("platforms.other") : item.displayName,
          icon: <SourceIcon platform={item.id} />,
        }))}
        activePlatform={platform.id}
        onSelectPlatform={(platformId) =>
          navigation.set((old) => ({ ...old, platformId }))
        }
        navLabel={t("platforms.title")}
        title={platformLabel}
        addAction={addAction}
        error={error || undefined}
        retryLabel={t("retry")}
        onRetry={() => void refreshConnector().catch(() => {})}
        loading={!sourcesLoaded}
        emptyMessage={t("platforms.empty")}
        renderSection={(content) => (
          <EntitySection
            as="section"
            className="flex min-h-0 min-w-0 flex-col overflow-y-auto"
            aria-label={platformLabel}
          >
            {content}
          </EntitySection>
        )}
      >
        {entries.map((source) => (
          <ConnectorCard key={source.id} source={source} />
        ))}
      </PlatformsPageView>
    </EntityInventory>
  );
}
