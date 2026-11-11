import { Frame } from "sdg";
import { Panel, PanelHeader, PanelShell } from "../components/panel";
import { copy, frames, releases } from "../fixtures/updates";
import { UpdateAboutContent, UpdateContent, UpdateHistoryContent } from "../modules/updates";

export default () => [
  ...frames.map(({ name, note }) => (
    <Frame name={name} note={note}>
      <PanelShell width={520} class="gap-2 p-6">
        <PanelHeader title={copy.title} close={false} />
        <UpdateContent state={name} />
      </PanelShell>
    </Frame>
  )),
  <Frame name="history" note="Proposed history dialog. The current About section has no history entry.">
    <Panel width={520} title={copy.history}>
      <UpdateHistoryContent entries={releases} />
    </Panel>
  </Frame>,
  <Frame name="settings" note="Proposed About section inside Settings. Capture the embedded section after adoption.">
    <div class="w-[720px] bg-surface-raised p-6">
      <UpdateAboutContent />
    </div>
  </Frame>,
];
