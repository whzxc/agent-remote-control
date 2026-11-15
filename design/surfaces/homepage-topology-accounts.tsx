import { Frame } from 'adg';
import { HomepageScene } from '../modules/homepage-scene';
import { topologyScenes } from '../fixtures/topology';
export default () => <Frame name="folded-accounts" width={1280} height={800} fixture="topology-accounts-dense"
  capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.accounts} /></Frame>;
