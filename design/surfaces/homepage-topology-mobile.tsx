import { Frame } from "sdg";
import { TopologyScene, type ScenePath } from "../components/topology-scene";
import { TopologyNode } from "../components/topology-node";
import { TopologyMark } from "../components/topology-mark";
import { TaskBubble } from "../components/task-bubble";
import { BoardHeader } from "../components/board-header";
import { NavCapsule } from "../components/nav-capsule";
import { nodes } from "../scenes/topology";

const sourceNodes = [
  { node: 1, x: 16, y: 64 },
  { node: 2, x: 16, y: 124 },
  { node: 3, x: 16, y: 184 },
  { node: 4, x: 16, y: 244 },
];
const agentNodes = [
  { node: 5, x: 326, y: 451 },
  { node: 6, x: 326, y: 610 },
  { node: 7, x: 326, y: 682 },
];
const tasks = [
  { title: "Inspect the dispatch queue", headline: "Reading queue state", y: 389 },
  { title: "Verify account attribution", headline: "Checking the workspace", y: 475 },
];
const dispatch = { model: "GPT-6.1 Sol", effort: "High reasoning effort", position: { count: 4, index: 2 }, tier: "Fast", fast: true };
const paths: readonly ScenePath[] = [
  { d: "M40 88V292Q40 316 64 316H158", class: "fill-none stroke-role-source/52", "stroke-width": "2" },
  { d: "M232 316H326Q350 316 350 340V706", class: "fill-none stroke-role-agent/52", "stroke-width": "2" },
  { d: "M350 475H330Q320 475 320 465V440Q320 432 308 432 M350 475H330Q320 475 320 485V510Q320 518 308 518", class: "fill-none stroke-role-agent/52", "stroke-width": "2" },
];

export default () => <Frame name="narrow-two-tasks" width={390} height={844} fixture="portrait-topology-2" capture={{ page: true, origin: "0 0", viewport: "390x844" }}>
  <TopologyScene width={390} height={844} paths={paths} items={[
    ...[...sourceNodes, ...agentNodes].map(({ node, x, y }) => ({ x, y, content: <TopologyNode {...nodes[node]} hideLabel /> })),
    ...tasks.map(({ y, ...task }) => ({ x: 16, y, content: <TaskBubble {...task} width={292} duration="1:23" phase="Running comm…" tone="command" icon="terminal" project="acceptance" dispatch={dispatch} sourceBrand="openai" /> })),
    { x: 142, y: 263, content: <TopologyMark size={106} sourceAction={false} agentAction={false} /> },
    { x: 16, y: 790, content: <NavCapsule /> },
  ]}>
    <div class="absolute inset-x-0 top-4 flex justify-center">
      <BoardHeader date="January 1 · Thu" time="08:00" title="Board" summary="2 running" />
    </div>
  </TopologyScene>
</Frame>;
