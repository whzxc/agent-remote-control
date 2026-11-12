import { Frame } from "adg";
import { Panel } from "../components/panel";
import { Button } from "../components/button";
import { ConnectionList } from "../modules/connection-management";
import { connectionExamples, connectionCopy } from "../fixtures/connection-management";

export default () => (
  <Frame
    name="overview" width={1280} height={800}
    fixture="p3-workspace-add-light"
    capture={{ region: "连接", viewport: "1280x800" }}
  >
    <Panel size="l" slot="center" title={connectionCopy.title}
      actions={<Button variant="primary" icon="plus">{connectionCopy.add}</Button>}>
      <ConnectionList connections={connectionExamples} />
    </Panel>
  </Frame>
);
