import { SourceConnectorSummary } from "../modules/connectors";
import { Frame } from "sdg";
import { PanelLoading, PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";

import { SourceTaskGroups } from "../modules/source-activity";
import { sourcePanelCopy } from "../fixtures/source-activity";

function SourcePanel({
  form,
}: {
  form: "dispatches" | "history" | "platform" | "loading";
}) {
  const platform = form === "platform";
  return (
    <PanelShell width={480} class="max-h-[768px] overflow-hidden pt-5">
      <header class="mx-5 flex h-9 shrink-0 items-center gap-4">
        <BrandMark brand="anthropic" size={36} />
        <h2 class="flex-1 text-title font-[650]">
          {platform ? "Anthropic" : "Claude"}
        </h2>
        <div class="flex gap-[6px]">
          <IconButton icon="maximize-2" label="Expand" />
          <IconButton icon="x" label="Close" />
        </div>
      </header>
      <div class="min-h-0 overflow-y-auto px-5 pb-5">
        {platform ? (
          <SourceConnectorSummary />
        ) : form === "loading" ? (
          <PanelLoading label={sourcePanelCopy.loading} />
        ) : (
          <div class="mt-7">
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
  <Frame name="loading" note="The current dispatch panel does not distinguish an initial read from an empty result.">
    <SourcePanel form="loading" />
  </Frame>,
];
