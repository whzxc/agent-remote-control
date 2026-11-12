
import { RelayHostingContent } from '../modules/relay-hosting';
import { Frame } from "adg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";

export default () => (
  <Frame

    name="empty"
    fixture="relay-hosting-light"
    capture={{ selector: ".layer-panel", viewport: "1280x800" }}
  >
    <Panel viewportHeight={800}
      title="Relay hosting"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <RelayHostingContent  />
    </Panel>
  </Frame>
);
