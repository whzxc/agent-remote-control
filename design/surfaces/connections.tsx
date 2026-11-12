import { Frame } from "adg";
import { Panel } from "../components/panel";
import { Button } from "../components/button";
import { ConnectionList } from "../modules/connection-management";
import { connectionExamples, connectionCopy } from "../fixtures/connection-management";

export default () => (
  <Frame
    name="overview"
    fixture="p3-workspace-add-light"
    capture={{ selector: ".layer-panel", viewport: "1280x800" }}
  >
    <Panel viewportHeight={800} title={connectionCopy.title}
      actions={<Button variant="primary" icon="plus">{connectionCopy.add}</Button>}>
      <ConnectionList connections={connectionExamples} />
    </Panel>
  </Frame>
);
