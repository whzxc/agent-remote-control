import { Frame } from "adg";
import { Panel, Dialog } from "../components/panel";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { AgentIcon } from "../components/agent-icon";
import { TopologyScreen } from "../modules/homepage-topology";
import { RelayHostingContent } from "../modules/relay-hosting";
import { GeneralSettingsContent } from "../modules/general-settings";
import { TopologyNode } from "../modules/topology-node";
import { QuotaCards } from "../modules/quota";
import { AgentTaskHistory } from "../modules/agent-activity";
import { shortAgentHistory } from "../fixtures/agent-activity";
import { agentQuotas } from "../fixtures/quota";
import { layerCopy, workspaceScenes, fixedAgentScene, selectedAgentNode } from "../fixtures/layers";

function Workspace({ settings = false }: { settings?: boolean }) {
  return (
    <Panel size="l" title={settings ? layerCopy.settings : layerCopy.relay}
      actions={<IconButton icon="maximize-2" label={layerCopy.expand} />}>
      {settings ? <GeneralSettingsContent /> : <RelayHostingContent />}
    </Panel>
  );
}
function WorkspaceScene({ portrait = false, dialog = false, settings = false }: {
  portrait?: boolean;
  dialog?: boolean;
  settings?: boolean;
}) {
  return (
    <TopologyScreen width={portrait ? 640 : 1280} height={800}
      scene={workspaceScenes[portrait ? "portrait" : "landscape"]} hideNodeLabels={portrait}>
      <div class="absolute inset-0 flex items-start justify-center px-(--layer-side-margin)
        pt-(--layer-top) pb-(--layer-side-margin)">
        <Workspace settings={settings} />
      </div>
      {dialog && (
        <div class="absolute inset-0 flex items-start justify-center bg-layer-scrim px-(--layer-side-margin)
          pt-(--layer-dialog-top) pb-(--layer-side-margin)">
          <Dialog size="s" title={layerCopy.confirmation} footer={
            <div class="flex justify-end gap-3">
              <Button>{layerCopy.cancel}</Button><Button variant="danger">{layerCopy.reset}</Button>
            </div>
          }>
            <p class="text-body leading-5">{layerCopy.consequence}</p>
          </Dialog>
        </div>
      )}
    </TopologyScreen>
  );
}

function NodeScene() {
  return (
    <TopologyScreen width={1280} height={800} scene={fixedAgentScene}>
      <div data-free class="absolute" style={{ left: selectedAgentNode.x, top: selectedAgentNode.y }}>
        <TopologyNode {...selectedAgentNode} hideLabel />
      </div>
      <div class="absolute inset-0 flex items-start justify-end px-(--layer-side-margin)
        pt-(--layer-top) pb-(--layer-side-margin)">
        <Panel size="m" title={
          <span class="flex items-center gap-3"><AgentIcon brand="codex" size={44} />{layerCopy.agent}</span>
        }
          actions={<IconButton icon="maximize-2" label={layerCopy.expand} />}>
          <div class="flex flex-col gap-6">
            <QuotaCards windows={agentQuotas} />
            <AgentTaskHistory groups={shortAgentHistory} />
          </div>
        </Panel>
      </div>
    </TopologyScreen>
  );
}

export default () => [
  <Frame name="workspace-fit" width={1280} height={800}
    note="Proposed desktop center slot: 48px top, L width, content-fit Relay hosting empty state. Browser top line is 20px.">
    <WorkspaceScene />
  </Frame>,
  <Frame name="workspace-cap" width={1280} height={800}
    note="Full Settings content reaches the height cap at y=784. The header stays fixed while the body scrolls.">
    <WorkspaceScene settings />
  </Frame>,
  <Frame name="workspace-dialog" width={1280} height={800}
    note="Proposed dialog slot: 12vh = 96px top, S width. Parent stays at its original bounds beneath the scrim.">
    <WorkspaceScene settings dialog />
  </Frame>,
  <Frame name="node-panel" width={1280} height={800}
    note="Proposed right slot: 48px top, 16px side, M width. Source-side panels mirror this slot at the left margin.">
    <NodeScene />
  </Frame>,
  <Frame name="portrait-workspace" width={640} height={800}
    note="Proposed collapsed slot: 48px desktop top, full available width of 608px; the same content fits its height.">
    <WorkspaceScene portrait />
  </Frame>,
];
