import { Frame } from "sdg";
import { TopologyScreen } from "../modules/homepage-topology";
import { scenes } from "../fixtures/topology";

const frames = [
  {
    "name": "studio",
    "width": 1280,
    "height": 800,
    "fixture": "arc-actions-light",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "1280x800"
    },
    "scene": "studio-studio"
  }
] as const;

export default () => frames.map(({ scene, ...frame }) => (
  <Frame {...frame}><TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} /></Frame>
));
