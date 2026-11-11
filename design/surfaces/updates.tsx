import { Frame } from "adg";
import { Panel, PanelHeader, PanelShell } from "../components/panel";
import { copy, frames, releases } from "../fixtures/updates";
import { UpdateAboutContent, UpdateContent, UpdateHistoryContent } from "../modules/updates";

export default () => [
  ...frames.map(({ name, fixture }) => (
    <Frame name={name} fixture={fixture} capture={{ region: "应用更新", viewport: "1280x800" }}>
      <PanelShell width={520} class="gap-2 p-6">
        <PanelHeader title={copy.title} close={false} />
        <UpdateContent state={name} />
      </PanelShell>
    </Frame>
  )),
  <Frame name="history" fixture="updates-history"
    capture={{ region: copy.history, viewport: "1280x800", clicks: [copy.history] }}>
    <Panel width={520} title={copy.history}>
      <UpdateHistoryContent entries={releases} />
    </Panel>
  </Frame>,
  <Frame name="settings" fixture="updates-settings"
    capture={{ selector: ".settings-about", viewport: "1280x800" }}>
    <div class="w-[672px] bg-surface-raised">
      <UpdateAboutContent />
    </div>
  </Frame>,
];
