import { Frame } from 'adg';
import { HomepageScene } from '../modules/homepage-scene';
import { topologyScenes } from '../fixtures/topology';

export default () => [
  <Frame name="idle" width={1280} height={800} fixture="portrait-topology-0"
    capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.idle} /></Frame>,
  <Frame name="working" width={1280} height={800} fixture="topology-accounts"
    capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.working} /></Frame>,
  <Frame name="device-branch" width={1280} height={800} fixture="homepage-modes-portrait-device"
    capture={{page:true,origin:'0 0',viewport:'1280x800'}}><HomepageScene scene={topologyScenes['device-landscape']}/></Frame>,
];
