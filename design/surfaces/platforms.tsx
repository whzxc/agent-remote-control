import { frames } from '../fixtures/connectors';
import { ConnectorContent } from '../modules/connectors';
import { Frame } from "adg";
import { Panel } from "../components/panel";


import { IconButton } from "../components/icon-button";





export default () =>
  frames.map((frame) => (
    <Frame
      name={frame.name} width={1280} height={800}
      fixture="accounts"
      capture={{
        region: "Platforms",
        viewport: "1280x800",
        ...(frame.name === "empty" ? { clicks: ["Google"] } : {}),
      }}
    >
      <Panel
        size="l" slot="center"
          title="Platforms"
        actions={<IconButton icon="maximize-2" label="Expand" />}
      >
        <ConnectorContent frame={frame} />
      </Panel>
    </Frame>
  ));
