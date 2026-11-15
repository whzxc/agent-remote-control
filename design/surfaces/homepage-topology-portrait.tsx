import { Frame } from 'adg';
import { HomepageScene } from '../modules/homepage-scene';
import { topologyScenes } from '../fixtures/topology';
const forms = [
  ['portrait', 'portrait-topology-0'],
  ['sources-folded', 'portrait-topology-sources-folded'],
  ['agents-folded', 'portrait-topology-agents-folded'],
] as const;
const foldedFrames = () => forms.map(([name, fixture]) => <Frame name={name} width={640} height={800} fixture={fixture}
  capture={{ page: true, origin: '0 0', viewport: '640x800' }}><HomepageScene scene={topologyScenes[name]} /></Frame>);

export default () => [...foldedFrames(),
  <Frame name="device-branch" width={800} height={1250} fixture="homepage-modes-portrait-device"
    capture={{page:true,origin:'0 0',viewport:'800x1250'}}><HomepageScene scene={topologyScenes['device-portrait']}/></Frame>,
];
