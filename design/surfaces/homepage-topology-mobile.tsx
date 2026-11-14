import { mobileCopy, mobileCopySamples } from "../fixtures/topology-mobile";
import { sourceNodes, agentNodes, tasks, dispatch, paths } from "../fixtures/topology-mobile";
import { Frame } from "adg";
import { TopologyScene } from "../modules/topology-scene";
import { TopologyNode } from "../modules/topology-node";
import { TopologyMark } from "../modules/topology-mark";
import { TaskBubble } from "../modules/task-presentation";
import { HomepageBar } from "../modules/homepage-mode";
import { NavCapsule } from "../modules/nav-capsule";
import { nodes } from "../fixtures/topology";

export default () => (
  <Frame
    name="narrow-two-tasks"
    width={390}
    height={844}
    fixture="portrait-topology-2"
    capture={mobileCopySamples.sample1}
  >
    <TopologyScene
      width={390}
      height={844}
      paths={paths}
      items={[
        ...[...sourceNodes, ...agentNodes].map(({ node, x, y }) => ({
          x,
          y,
          content: <TopologyNode {...nodes[node]} hideLabel />,
        })),
        ...tasks.map(({ y, ...task }) => ({
          x: 16,
          y,
          content: (
            <TaskBubble
              {...task}
              width={292}
              duration={mobileCopy.text2}
              phase={mobileCopy.text3}
              tone="command"
              icon="terminal"
              project={mobileCopy.text4}
              dispatch={dispatch}
              sourceBrand="openai"
            />
          ),
        })),
        { x: 142, y: 263, content: <TopologyMark size={106} sourceAction={false} agentAction={false} /> },
        { x: 16, y: 790, content: <NavCapsule /> },
      ]}
    >
      <div class="absolute inset-x-4 top-12">
        <HomepageBar mode="topology" compact date="January 1 · Thu" time="08:00" title={mobileCopy.text5} />
      </div>
    </TopologyScene>
  </Frame>
);
