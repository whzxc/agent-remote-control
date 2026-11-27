import { SourceConnectorSummary } from "../modules/connectors";
import { Frame } from "adg";
import { PanelLoading, PanelShell } from "../components/panel";
import { BrandMark } from "../components/brand-mark";
import { IconButton } from "../components/icon-button";

import { SourceTaskGroups } from "../modules/source-activity";
import { sourcePanelCopy } from "../fixtures/source-activity";

export function SourcePanelHeader({ title }: { title: string }) {
  return (
    <header className="flex h-9 shrink-0 items-center gap-4">
      <BrandMark brand="anthropic" size={36} />
      <h2 className="flex-1 text-title font-[650]">{title}</h2>
      <div className="flex gap-[6px]">
        <IconButton icon="maximize-2" label="Expand" />
        <IconButton icon="x" label="Close" />
      </div>
    </header>
  );
}

function SourcePanel({
  form,
}: {
  form: "dispatches" | "history" | "platform" | "loading";
}) {
  const platform = form === "platform";
  return (
    <PanelShell viewportHeight={800} className="gap-[25px] overflow-hidden pt-[13px] px-6 pb-6">
      <SourcePanelHeader title={platform || form === "loading" ? "Anthropic" : "Claude"} />
      <div className="min-h-0 overflow-y-auto">
        {platform ? (
          <SourceConnectorSummary className="" />
        ) : form === "loading" ? (
          <PanelLoading label={sourcePanelCopy.loading} />
        ) : (
          <div>
            <SourceTaskGroups history={form === "history"} />
          </div>
        )}
      </div>
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="dispatches"
    fixture="source-panel"
    capture={{ region: "Claude", viewport: "1280x800" }}
  >
    <SourcePanel form="dispatches" />
  </Frame>,
  <Frame
    name="history"
    fixture="dispatch-states"
    capture={{ region: "Claude", viewport: "1280x800" }}
    note="The dispatch body scrolls within the 800px viewport."
  >
    <SourcePanel form="history" />
  </Frame>,
  <Frame
    name="platform"
    fixture="source-panel"
    capture={{
      region: "Anthropic",
      viewport: "1280x800",
      clicks: ["Anthropic"],
    }}
  >
    <SourcePanel form="platform" />
  </Frame>,
  <Frame name="loading" fixture="source-panel-loading" capture={{ selector: ".layer-panel", viewport: "1280x800" }}>
    <SourcePanel form="loading" />
  </Frame>,
];
