import { Frame, Icon } from "adg";
import { Plus } from "lucide-react";
import { PlatformsPageView } from "@/components/connectivity/PlatformsPageView";
import { Button, PrivacyProvider } from "@/components/kit";
import { ConnectorCardView } from "@/components/objects/ConnectorCardView";
import { LocaleProvider } from "@/i18n/react";
import { BrandMark, type Brand } from "../components/brand-mark";
import { platformChoices as platforms } from "../fixtures/choices";
import {
  copy,
  details,
  frames,
  sourceConnectorCopy,
  sourceFacts,
} from "../fixtures/connectors";

function cleanStatus(state: string): string {
  return state.replace(/^·\s*/, "");
}

export function ConnectorCard({
  brand = "openai",
  title = copy.text1,
  state = copy.text2,
  facts = details,
}: {
  brand?: Brand;
  title?: string;
  state?: string;
  facts?: string[][][];
} = {}) {
  return (
    <LocaleProvider locale="en">
      <PrivacyProvider hidden>
        <ConnectorCardView
          title={title}
          statusLabel={cleanStatus(state)}
          connected
          icon={<BrandMark brand={brand} size={28} />}
          facts={facts.map((group) =>
            group.map(([label, value]) => ({ label, value })),
          )}
          renameLabel={copy.text3}
          removeLabel={copy.text4}
        />
      </PrivacyProvider>
    </LocaleProvider>
  );
}

export function ConnectorContent({
  frame,
}: {
  frame: (typeof frames)[number];
}) {
  return (
    <LocaleProvider locale="en">
      <PlatformsPageView
        platforms={platforms.map(([value, label]) => ({
          id: value,
          label,
          icon:
            value === "other" ? (
              <Icon name="plug" size={20} />
            ) : (
              <BrandMark brand={value as Brand} size={20} />
            ),
        }))}
        activePlatform={frame.platform}
        navLabel={copy.text6}
        title={frame.title}
        addAction={
          <Button variant="primary">
            <Plus size={15} strokeWidth={1.75} absoluteStrokeWidth aria-hidden="true" />
            {copy.text7}
          </Button>
        }
        emptyMessage={copy.text8}
      >
        {frame.name === "connected" ? <ConnectorCard /> : null}
      </PlatformsPageView>
    </LocaleProvider>
  );
}

export function SourceConnectorSummary({
  className: extra = "mt-7",
}: {
  className?: string;
}) {
  return (
    <div className={extra}>
      <ConnectorCard
        brand="anthropic"
        title={sourceConnectorCopy.text1}
        state={sourceConnectorCopy.text2}
        facts={sourceFacts.map((row) =>
          row.map((fact) => [fact.label, fact.value]),
        )}
      />
    </div>
  );
}

export default () => [
  <Frame key="connector-card" name="connector-card" width={672}>
    <div className="w-full bg-surface-raised">
      <ConnectorCard />
    </div>
  </Frame>,
  <Frame
    key="connector-content-connected"
    name="connector-content-connected"
    width={912}
  >
    <div className="w-full bg-surface-raised">
      <ConnectorContent frame={frames[0]} />
    </div>
  </Frame>,
  <Frame
    key="connector-content-empty"
    name="connector-content-empty"
    width={912}
  >
    <div className="w-full bg-surface-raised">
      <ConnectorContent frame={frames[1]} />
    </div>
  </Frame>,
  <Frame
    key="source-connector-summary"
    name="source-connector-summary"
    width={440}
  >
    <div className="w-full bg-surface-raised">
      <SourceConnectorSummary className="" />
    </div>
  </Frame>,
];
