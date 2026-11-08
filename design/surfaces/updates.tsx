import { frames } from '../fixtures/updates';
import { UpdateContent, UpdateAboutContent } from '../modules/updates';
import { Frame } from "sdg";
import { Panel } from "../components/panel";




export default () => [
  ...frames.map(({ name, fixture }) => (
    <Frame
      name={name}
      fixture={fixture}
      capture={{ region: "App updates", viewport: "1280x800" }}
    >
      <Panel width={520} title="New version 1.2.3">
        <UpdateContent name={name} />
      </Panel>
    </Frame>
  )),
  <Frame
    name="settings"
    note="Unavailable: no standalone About shell. updates-settings embeds AppUpdate in SettingsPage; neither .settings-about nor its .page-sheet ancestor matches this standalone 720×258 panel."
  >
    <Panel width={720} headerless>
      <UpdateAboutContent  />
    </Panel>
  </Frame>,
];
