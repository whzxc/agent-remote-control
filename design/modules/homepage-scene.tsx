import { Frame } from 'adg';
import { TopologyScene, type TopologySceneData } from '../components/topology-scene';
import { HomepageBar } from '../components/homepage-mode';
import { NavCapsule } from '../components/nav-capsule';
import { topologyScenes } from '../fixtures/topology';

export function HomepageScene({ scene, chrome = true }: { scene: TopologySceneData; chrome?: boolean }) {
  return <div data-free class="relative bg-canvas text-text" style={{ width: scene.width, height: scene.height }}>
    <TopologyScene scene={scene} />
    {chrome && <>
      <div class="absolute top-6 inset-x-6"><HomepageBar mode="topology" compact={scene.width < 1000} time={scene.time} date={scene.date} title={scene.language === "zh-CN" ? "公示牌" : "Board"} language={scene.language} /></div>
    </>}
    <div class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
  </div>;
}
export default () => <Frame name="idle" width={1280} height={800} fixture="portrait-topology-0"
  capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.idle} /></Frame>;
