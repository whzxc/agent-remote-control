import { Frame } from "adg";
import { TopologyScreen } from "../modules/homepage-topology";
import { scenes } from "../fixtures/topology";

const frames = [
  {
    "name": "expanded-empty",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-0",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-expanded-empty"
  },
  {
    "name": "expanded-two-tasks",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-2",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-expanded-two-tasks"
  },
  {
    "name": "sources-compacted",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-4",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-sources-compacted"
  },
  {
    "name": "sources-folded",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-sources-folded",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-sources-folded"
  },
  {
    "name": "agents-folded",
    "width": 640,
    "height": 800,
    "fixture": "portrait-topology-agents-folded",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x800"
    },
    "scene": "portrait-agents-folded"
  },
  {
    "name": "expanded-single-task",
    "width": 640,
    "height": 1000,
    "fixture": "portrait-topology-1",
    "capture": {
      "page": true,
      "origin": "0 0",
      "viewport": "640x1000"
    },
    "scene": "portrait-expanded-single-task"
  },
  {
    "name": "tasks-and-accounts",
    "width": 640,
    "height": 1000,
    "fixture": "portrait-topology-accounts",
    "capture": { "page": true, "origin": "0 0", "viewport": "640x1000" },
    "scene": "portrait-tasks-and-accounts"
  }
] as const;

export default () => frames.map(({ scene, ...frame }) => (
  <Frame {...frame}><TopologyScreen width={frame.width} height={frame.height} scene={scenes[scene]} hideNodeLabels /></Frame>
));
