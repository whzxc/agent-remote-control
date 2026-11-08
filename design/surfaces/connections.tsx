import { Frame } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Button } from "../components/button";
import { ConnectionList } from "../modules/connection-management";
import { connectionExamples, connectionCopy } from "../fixtures/connection-management";

export default () => (
  <Frame
    name="overview"
    fixture="p3-workspace-add-light"
    capture={{ region: "连接", viewport: "1280x800" }}
  >
    <PanelShell width={680} class="px-6 pt-[13px] pb-6 gap-[25px]">
      <PanelHeader
        title={connectionCopy.title}
        actions={
          <Button variant="primary" icon="plus">
            {connectionCopy.add}
          </Button>
        }
      />
      <ConnectionList connections={connectionExamples} />
    </PanelShell>
  </Frame>
);
