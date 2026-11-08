import { Frame } from "sdg";
import { TopologyScreen } from "../modules/homepage-topology";
import { scenes } from "../fixtures/topology";

const frames = [
  {
    "name": "tasks",
    "width": 1280,
    "height": 800,
    "fixture": "parallel-seven",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "1280x800"
    },
    "scene": "tasks-tasks"
  }
] as const;

export default () => frames.map(({ scene, ...frame }) => (
  <Frame {...frame}><TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} /></Frame>
));
