import { frames } from '../fixtures/connectors';
import { ConnectorContent } from '../modules/connectors';
import { Frame } from "adg";
import { Panel } from "../components/panel";


import { IconButton } from "../components/icon-button";





export default () =>
  frames.map((frame) => (
    <Frame
      name={frame.name}
      fixture="accounts"
      capture={{
        selector: ".layer-panel",
        viewport: "1280x800",
        ...(frame.name === "empty" ? { clicks: ["Google"] } : {}),
      }}
    >
      <Panel viewportHeight={800}
          title="Platforms"
        actions={<IconButton icon="maximize-2" label="Expand" />}
      >
        <ConnectorContent frame={frame} />
      </Panel>
    </Frame>
  ));
