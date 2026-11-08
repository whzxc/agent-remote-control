import { Frame } from "sdg";
import { TopologyScreen } from "../modules/homepage-topology";
import { scenes } from "../fixtures/topology";

const frames = [
  {
    "name": "accounts",
    "width": 1280,
    "height": 800,
    "fixture": "topology-accounts",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "1280x800"
    },
    "scene": "accounts-accounts"
  },
  {
    "name": "dense",
    "width": 1280,
    "height": 800,
    "fixture": "topology-accounts-dense",
    "capture": { "page": true, "origin": "0 0", "viewport": "1280x800" },
    "scene": "accounts-dense"
  }
] as const;

export default () => frames.map(({ scene, ...frame }) => (
  <Frame {...frame}><TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} /></Frame>
));
