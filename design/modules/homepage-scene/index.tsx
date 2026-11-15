import { Frame } from 'adg';
import { nodeCapsuleLayout, NodeCapsule } from './node-capsule';
import { HomepageScene } from './topology-scene';
import { topologyScenes } from '../../fixtures/topology';
import { capsuleForms, quotaReadings, accountContrast } from '../../fixtures/node-capsule';
import { AgentIcon } from './agent-icon';
import { BrandMark } from '../../components/brand-mark';
import { TopologyGroup } from './topology-group';
import { PhaseLabel, TaskActivityIcon } from './task-activity';
import { recentSteps } from '../../fixtures/task-activity';
import { TopologyNode } from './topology-node';
import { example } from '../../fixtures/topology-node';
import { markForms, recoveryForms } from '../../fixtures/topology-mark';
import { TopologyMark, ArcRecovery } from './topology-mark';
export { type AgentIconReading, AgentIcon } from './agent-icon';
export { NodePanelHeading } from './node-panel-heading';
export { type TopologySceneData, TopologyScene, HomepageScene } from './topology-scene';
export { type TopologyGroupQuota, type TopologyGroupMember, type TopologyGroupProps, TopologyGroup } from './topology-group';
export { GraphFeedback, GraphAction, HubEntry } from './graph-actions';
export { NavCapsule, type HomepageMode, HomepageModeSwitch, HomepageBar } from './navigation';
export { type TaskStepKind, type TaskStep, type TaskPlan, type TaskChange, TaskActivityIcon, PhaseLabel } from './task-activity';
export { type NodeTaskState, capsuleMaximum, nodeCapsuleLayout, NodeCapsule } from './node-capsule';
export { type TopologyNodeProps, TopologyNode } from './topology-node';
export { TopologyMark, ArcRecovery } from './topology-mark';

const homepageSpecimen = () => <Frame name="idle" width={1280} height={800} fixture="portrait-topology-0"
  capture={{ page: true, origin: '0 0', viewport: '1280x800' }}><HomepageScene scene={topologyScenes.idle} /></Frame>;

const capsuleSpecimens = () => [
  ...capsuleForms.filter(form => !['unread', 'compact'].includes(form.name)).map(({ name, state, compact, wing, brand = 'codex', label = 'Codex' }) => {
    const model = nodeCapsuleLayout(state, compact);
    return <Frame name={`capsule-${name}`} width={model.width} height={48}
      note="The quota ring is the capsule outline. Logo anchor stays fixed; width and the outer port use the topology spring 210/26; reduced motion is direct.">
      <div class="flex h-12" style={{ width: model.width }}>
        {wing === 'left' && <span class="flex-1" />}
        <NodeCapsule label={label} graphic={<AgentIcon brand={brand} readings={quotaReadings} />}
          mark={<BrandMark brand={brand} size={28} />} readings={quotaReadings}
          state={state} compact={compact} wing={wing} />
      </div>
    </Frame>;
  }),
  <Frame name="account-contrast" width={420} height={72}>
    <div class="flex w-[420px] items-start justify-between gap-6 pt-1">
      <NodeCapsule label="Codex" graphic={<AgentIcon brand="codex" readings={quotaReadings} />}
        mark={<BrandMark brand="codex" size={28} />} readings={quotaReadings} state={capsuleForms[1].state} />
      <TopologyGroup {...accountContrast} />
    </div>
  </Frame>,
];

const homepageSceneFrames = () => [homepageSpecimen(), ...capsuleSpecimens()];

const taskActivityFrames = () => [
  <Frame name="phase-label"><PhaseLabel>Thinking</PhaseLabel></Frame>,

  <Frame name="task-activity-icons">
    <div class="flex items-center gap-3">
      {[...new Set(recentSteps.map(step => step.kind)), 'waiting' as const].map(kind => <TaskActivityIcon kind={kind} />)}
    </div>
  </Frame>
];

const nodeCapsuleFrames = () => <Frame name="capsule" width={132} height={48}>
  <NodeCapsule label="Codex" graphic={<BrandMark brand="codex" size={38}/>} mark={<BrandMark brand="codex" size={28}/>} state={{running:2,steps:['reading','thinking']}}/>
</Frame>;

const topologyNodeFrames = () => (
  <Frame name="node-default">
    <TopologyNode {...example} />
  </Frame>
);

const topologyMarkFrames = () => [
  ...markForms.map(({ name, note, ...props }) => (
    <Frame name={name} note={note}>
      <TopologyMark {...props} />
    </Frame>
  )),
  ...recoveryForms.filter(form => !['core', 'blocked'].includes(form.form)).map(({ form, note }) => (
    <Frame name={`arc-recovery-${form}`} note={note}>
      <ArcRecovery form={form} />
    </Frame>
  )),
];

export default () => [
  ...homepageSceneFrames(),
  ...taskActivityFrames(),
  nodeCapsuleFrames(),
  topologyNodeFrames(),
  ...topologyMarkFrames(),
];
