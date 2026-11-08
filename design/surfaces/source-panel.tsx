import { SourceConnectorSummary } from "../modules/connectors";
import { Frame } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";

import { SourceTaskGroups } from "../modules/source-activity";

function SourcePanel({
  form,
}: {
  form: "dispatches" | "history" | "platform";
}) {
  const platform = form === "platform";
  return (
    <PanelShell width={480} height={form === "history" ? 968 : 560} class="p-5">
      <header class="flex h-9 items-center gap-4">
        <BrandMark brand="anthropic" size={36} />
        <h2 class="flex-1 text-title font-[650]">
          {platform ? "Anthropic" : "Claude"}
        </h2>
        <div class="flex gap-[6px]">
          <IconButton icon="maximize-2" label="Expand" />
          <IconButton icon="x" label="Close" />
        </div>
      </header>
      {platform ? (
        <SourceConnectorSummary />
      ) : (
        <div class="mt-7">
          <SourceTaskGroups history={form === "history"} />
        </div>
      )}
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
    capture={{ region: "Claude", viewport: "1280x1200" }}
    note="Full-content drawing exceeds the scroll viewport; inspect remaining scroll content during browser acceptance."
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
];
