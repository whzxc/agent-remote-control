import { Frame } from 'adg';
import { TopologyNode } from '../modules/topology-node';
import { DeviceNode, DeviceBranch, DeviceNodePanel, ControllerSourcePanel,
  DeviceAddEndpoint, PortraitDeviceBranch } from '../modules/device-topology';
import { controllerForms, memberForms, portraitForms, landscapePaths, memberPaths,
  upstreamPaths, sourceNodes, copy } from '../fixtures/device-topology';
import { localRunning, localAttention } from '../fixtures/topology-task-state';
import { TopologyScreen } from '../modules/homepage-topology';
import { DeviceNavigation, DeviceTopologyEntry } from '../modules/device-link';
import { scenes } from '../fixtures/topology';
import { deviceCopy, locales, topologyOptions, topologyPlacement } from '../fixtures/device-link';

const retainedSummary = () => locales.flatMap(locale => topologyOptions.map(option => {
  const c = deviceCopy[locale];
  const scene = {
    ...scenes['empty-empty'],
    chrome: scenes['empty-empty'].chrome.filter(item => item.kind !== 'nav').map(item =>
      item.kind === 'board' ? { ...item, title: c.board, date: c.date } :
        item.kind === 'button' ? { ...item, label: c.addConnection } : item),
  };
  const position = topologyPlacement[option];
  return <Frame name={`${option}-${locale}`} width={1280} height={800}
    fixture={`device-summary-${locale}-light`} capture={{ page: true, viewport: "1280x800" }}
    note="Approved: one summary chip opens Devices. Existing ARC mark, earcups and branches remain intact.">
    <TopologyScreen width={1280} height={800} scene={scene}>
      <div data-free class="absolute inset-0">
        <div class="absolute flex justify-center w-[240px]" style={{ left: position.x, top: position.y }}>
          <DeviceTopologyEntry locale={locale} />
        </div>
        <div class="absolute left-6 bottom-6"><DeviceNavigation locale={locale} /></div>
      </div>
    </TopologyScreen>
  </Frame>;
}));


const chrome = (width: number, height: number) => [
  { kind: 'board' as const, x: (width - 240) / 2, y: 27, date: copy.date, time: copy.time, title: copy.board },
  { kind: 'nav' as const, x: 24, y: height - 68, active: '' },
];

export default () => [
  ...retainedSummary(),
  ...controllerForms.map(option => <Frame name={option.name} width={1280} height={800} locale="en"
    note="Proposed. Static configuration geometry. Task-state badges open scoped execution; offline is unconfirmed.">
    <TopologyScreen width={1280} height={800} scene={{
      nodes: [[132, 366, 17]], tasks: [],
      links: landscapePaths.map((path, i) => i === 3 && option.state === 'offline'
        ? { ...path, class: 'stroke-role-agent/20' } : path),
      mark: { x: 332, y: 300, size: 180, sourceAction: false, agentAction: false },
      chrome: chrome(1280, 800),
      items: [
        { x: 660, y: 170, content: <TopologyNode label="Codex" brand="codex" taskState={localRunning} /> },
        { x: 660, y: 280, content: <TopologyNode label="Claude Code" brand="claude-code" taskState={localAttention} /> },
        { x: 637, y: 'form' in option && option.form === 'merged-collapsed' ? 432 : 350,
          content: <DeviceBranch state={option.state} form={'form' in option ? option.form : undefined} /> },
        { x: 586, y: 704, content: <DeviceAddEndpoint /> },
      ],
    }}>
      {'panel' in option && option.panel && <div data-free class="absolute inset-0">
        <div class="absolute left-[800px] top-[216px]"><DeviceNodePanel /></div>
      </div>}
    </TopologyScreen>
  </Frame>),
  ...memberForms.map(({ name, upstreams }) => <Frame name={name} width={1280} height={800} locale="en"
    note="Proposed. Controller is tier 1 on the left; optional upstream sources stay off by default. Execution keeps controller attribution.">
    <TopologyScreen width={1280} height={800} scene={{
      nodes: [], tasks: [],
      links: [...memberPaths, ...(upstreams ? upstreamPaths : [])],
      mark: { x: 520, y: 280, size: 240, sourceAction: false, agentAction: false },
      chrome: chrome(1280, 800),
      items: [
        { x: 836, y: 240, content: <TopologyNode label="Codex" brand="codex" taskState={localRunning} /> },
        { x: 836, y: 450, content: <TopologyNode label="Claude Code" brand="claude-code" taskState={localAttention} /> },
        { x: 312, y: 240, content: <DeviceNode controller expanded /> },
        ...(upstreams ? sourceNodes.map(({ x, y, ...props }) => ({ x, y, content: <TopologyNode {...props} /> })) : []),
        { x: 244, y: 526, content: <ControllerSourcePanel upstreams={upstreams} /> },
      ],
    }} />
  </Frame>),
  ...portraitForms.map(({ name, width, height, narrow }) => <Frame name={name} width={width} height={height} locale="en"
    note="Proposed. Outer rails hide labels, keep accessible names and fold remote accounts before adding depth.">
    <TopologyScreen width={width} height={height} hideNodeLabels scene={{
      nodes: [[narrow ? 16 : 24, 100, 1]], tasks: [],
      links: [
        { d: narrow ? 'M40 124V292Q40 316 64 316H158' : 'M48 124V314Q48 338 72 338H282',
          class: 'stroke-role-source/55', 'stroke-width': '2' },
        { d: narrow ? 'M232 316H326Q350 316 350 340V748' : 'M358 338H568Q592 338 592 362V734',
          class: 'stroke-role-agent/55', 'stroke-width': '2' },
      ],
      mark: { x: narrow ? 142 : 282, y: narrow ? 263 : 300, size: narrow ? 106 : 76,
        sourceAction: false, agentAction: false },
      chrome: chrome(width, height),
      items: [
        { x: width - 72, y: 370, content: <TopologyNode hideLabel label="Codex" brand="codex" taskState={localRunning} /> },
        { x: 0, y: narrow ? 455 : 430, content: <PortraitDeviceBranch narrow={narrow} /> },
        { x: width - 54, y: narrow ? 742 : 728, content: <DeviceAddEndpoint /> },
      ],
    }} />
  </Frame>),
];
