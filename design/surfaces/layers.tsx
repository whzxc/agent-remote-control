import { Frame } from 'adg';
import { HomepageScene, NodePanelHeading } from '../modules/homepage-scene';
import { WorkspaceContent, NodePanelContent } from '../modules/layer-content';
import { GeneralSettingsContent } from '../modules/general-settings';
import { Button } from '../components/button';
import { Dialog, Panel } from '../components/panel';
import { IconButton } from '../components/icon-button';
import { topologyScenes } from '../fixtures/topology';
import { SetupFlow } from '../components/setup-flow';
import { ConnectionOnboarding } from '../modules/connection-onboarding';
import { SourceOnboarding } from '../modules/source-onboarding';
import { onboardingFrames } from '../fixtures/onboarding';

const capture = { page: true as const, origin: '0 0', viewport: '1280x800' };

function workspaceFrame(name: string, fixture: string) {
  const settings = name === 'workspace-cap';
  const home = name === 'hosting-home';
  const deploy = name === 'deploy-dialog';
  const scene = topologyScenes[settings ? 'workspace-cap' : 'workspace-fit'];
  return <Frame name={name} width={1280} height={800} fixture={fixture} capture={capture}>
    <div data-adg-id="workspace-stage" class="relative w-[1280px] h-[800px]">
      <div inert={deploy || undefined} aria-hidden={deploy ? 'true' : undefined}>
        <HomepageScene key="homepage" scene={scene} chrome={home} hosting active={home || deploy ? '' : settings ? 'settings' : 'relay-hosting'} />
        {!home && <div class="pointer-events-none absolute inset-0 flex items-center justify-center py-[76px]">
          <Panel key="center" motionId="center" closeLabel="Back to home" size="xl" retainedHeight={settings ? 648 : 200}
            headerHeight={settings ? 50 : undefined} title={settings ? 'Settings' : 'Relay hosting'}
            actions={<IconButton key="expand" icon="maximize-2" label="Expand panel width"/>}>
            {settings ? <GeneralSettingsContent /> : <WorkspaceContent />}
          </Panel>
        </div>}
      </div>
      {deploy && <div class="absolute inset-0 flex items-center justify-center py-5">
        <div data-adg-id="deployment-scrim" class="absolute inset-0 bg-layer-scrim" />
        <div class="relative flex w-full justify-center">
          <Dialog key="deploy" motionId="deployment" title="Deploy new relay"
            footer={<div class="flex justify-end"><Button variant="primary">Deploy new relay</Button></div>}>
            <p class="text-body text-text-secondary">No account? Sign up for free on the login page.</p>
          </Dialog>
        </div>
      </div>}
    </div>
  </Frame>;
}

const slots = [
  {name:'node-panel',scene:'node-panel',fixture:'agent-panel-short',height:474},
  {name:'portrait-workspace',scene:'portrait-workspace',fixture:'relay-hosting-light',height:200},
] as const;
export default () => [
  workspaceFrame('hosting-home', 'hosting-home'),
  workspaceFrame('workspace-fit', 'relay-hosting-light'),
  workspaceFrame('deploy-dialog', 'hosting-deploy'),
  workspaceFrame('workspace-cap', 'settings-about-light'),
  ...slots.map(slot => {
    const scene=topologyScenes[slot.scene], node=slot.name==='node-panel';
    return <Frame name={slot.name} width={scene.width} height={scene.height} fixture={slot.fixture}
      capture={{page:true,origin:'0 0',viewport:`${scene.width}x${scene.height}`}}>
      <div class="relative" style={{width:scene.width,height:scene.height}}>
        <HomepageScene scene={scene} chrome={node}/>
        <div data-free class="absolute inset-0 flex items-center justify-center py-[76px]">
          <Panel size={node?'m':'xl'} viewportWidth={scene.width} retainedHeight={slot.height} height={node ? slot.height : undefined} headerHeight={node?46:undefined}
            title={node?<NodePanelHeading/>:'Relay hosting'}
            headerless={node} actions={node?undefined:<IconButton icon="maximize-2" label="Expand"/>}>
            {node?<><NodePanelHeading/><div class="min-h-0 overflow-y-auto"><NodePanelContent/></div></>:<WorkspaceContent/>}
          </Panel>
        </div>
      </div>
    </Frame>;
  }),
  <Frame name="nested-dialog" width={1280} height={800} fixture="p3-stacked-method"
    capture={{page:true,origin:'0 0',viewport:'1280x800'}}>
    <div class="relative w-[1280px] h-[800px] bg-canvas">
      <div aria-hidden="true"><HomepageScene scene={topologyScenes['nested-dialog']} chrome={false} /></div>
      <div aria-hidden="true" inert class="absolute top-[192px] left-[360px] w-[560px] h-[420px]">
        <SetupFlow step={onboardingFrames.find(s=>s.name==='source-connection')!}><SourceOnboarding step={onboardingFrames.find(s=>s.name==='source-connection')!}/></SetupFlow>
      </div>
      <div class="absolute inset-0 bg-layer-scrim flex items-center justify-center py-5">
        <SetupFlow step={onboardingFrames.find(s=>s.name==='stacked-method')!}>
          <ConnectionOnboarding step={onboardingFrames.find(s=>s.name==='stacked-method')!}/>
        </SetupFlow>
      </div>
    </div>
  </Frame>,
];
