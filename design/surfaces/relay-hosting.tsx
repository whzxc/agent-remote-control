
import { RelayHostingContent } from '../modules/relay-hosting';
import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";

export default () => (
  <Frame
    name="empty"
    fixture="relay-hosting-light"
    capture={{ region: "Relay hosting", viewport: "1280x800" }}
  >
    <Panel
      width={760}
      title="Relay hosting"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <RelayHostingContent  />
    </Panel>
  </Frame>
);
