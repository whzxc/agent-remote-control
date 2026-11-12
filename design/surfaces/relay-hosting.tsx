
import { RelayHostingContent } from '../modules/relay-hosting';
import { Frame } from "adg";
import { Panel } from "../components/panel";
import { IconButton } from "../components/icon-button";

export default () => (
  <Frame
    width={1280} height={800}
    name="empty"
    fixture="relay-hosting-light"
    capture={{ region: "Relay hosting", viewport: "1280x800" }}
  >
    <Panel
      size="l" slot="center"
      title="Relay hosting"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <RelayHostingContent  />
    </Panel>
  </Frame>
);
