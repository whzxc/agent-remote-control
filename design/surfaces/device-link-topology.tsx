import { Frame } from 'adg';
import { TopologyNode } from '../modules/topology-node';
import { DeviceNode, DeviceBranch, DeviceNodePanel, ControllerSourcePanel,
  DeviceAddEndpoint, PortraitDeviceBranch } from '../modules/device-topology';
import { controllerForms, memberForms, portraitForms, landscapePaths, memberPaths,
  sourceNodes, copy } from '../fixtures/device-topology';
import { localRunning, localAttention, deviceAggregate, quotaReadings, overflow } from '../fixtures/node-capsule';
import { nodeCapsuleLayout } from '../modules/node-capsule';
import { HomepageHeader } from '../modules/homepage-mode';
import { NavCapsule } from '../modules/nav-capsule';
import { IconButton } from '../components/icon-button';
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


const chrome = (width: number, height: number, attention = 2) => [
  { kind: 'board' as const, x: (width - 240) / 2, y: 27, date: copy.date, time: copy.time, title: copy.board,
    mode: 'topology' as const, attention },
  { kind: 'nav' as const, x: 24, y: height - 68, active: '' },
];

export default () => [
  ...retainedSummary(),
  ...controllerForms.map(option => <Frame name={option.name} width={1280} height={800} locale="en"
    note="Proposed. Static configuration geometry. Working node capsules open scoped Tasks; offline is unconfirmed.">
    <TopologyScreen width={1280} height={800} scene={{
      nodes: [[89, 366, 17]], tasks: [],
      links: landscapePaths.map((path, i) => i === 3 && option.state === 'offline'
        ? { ...path, class: 'stroke-role-agent/20' } : path),
      mark: { x: 240, y: 300, size: 180, sourceAction: false, agentAction: false },
      chrome: chrome(1280, 800, 'idle' in option && option.idle ? 0 : 'overflow' in option && option.overflow ? 448 : option.state === 'offline' ? 1 : 2),
      items: [
        { x: 489, y: 170, content: <TopologyNode label="Codex" brand="codex" readings={quotaReadings} taskState={'idle' in option && option.idle ? {} : 'overflow' in option && option.overflow ? overflow : localRunning} /> },
        { x: 489, y: 280, content: <TopologyNode label="Claude Code" brand="claude-code" readings={quotaReadings} taskState={'idle' in option && option.idle ? {} : 'overflow' in option && option.overflow ? overflow : localAttention} /> },
        { x: 466, y: 310,
          content: <DeviceBranch state={option.state} overflow={'overflow' in option && option.overflow} panelOpen={'panel' in option && option.panel} idle={'idle' in option && option.idle} form={'form' in option ? option.form : undefined} /> },
        { x: 514, y: 704, content: <DeviceAddEndpoint /> },
      ],
    }}>
      {'panel' in option && option.panel && <div data-free class="absolute inset-0">
        <div class="absolute left-[818px] top-[162px]"><DeviceNodePanel /></div>
      </div>}
    </TopologyScreen>
  </Frame>),
  ...memberForms.map(({ name, upstreams }) => <Frame name={name} width={1280} height={800} locale="en"
    note="Proposed. Tier-1 controller source; upstream sources default off. Tasks keeps controller attribution.">
    <TopologyScreen width={1280} height={800} scene={{
      nodes: [], tasks: [],
      links: [...memberPaths, ...(upstreams ? [{
        d: `M${414 - nodeCapsuleLayout(deviceAggregate).width} 266H210Q194 266 194 250V190Q194 174 183 174 M194 266V302Q194 318 183 318`,
        class: 'stroke-role-source/55', 'stroke-width': '2',
      }] : [])],
      mark: { x: 520, y: 280, size: 240, sourceAction: false, agentAction: false },
      chrome: chrome(1280, 800),
      items: [
        { x: 836, y: 240, content: <TopologyNode label="Codex" brand="codex" readings={quotaReadings} taskState={localRunning} /> },
        { x: 836, y: 450, content: <TopologyNode label="Claude Code" brand="claude-code" readings={quotaReadings} taskState={localAttention} /> },
        { x: 312, y: 240, content: <DeviceNode controller expanded /> },
        ...(upstreams ? sourceNodes.map(({ x, y, ...props }) => ({ x, y, content: <TopologyNode {...props} /> })) : []),
        { x: 244, y: 526, content: <ControllerSourcePanel upstreams={upstreams} /> },
      ],
    }} />
  </Frame>),
  ...portraitForms.map(({ name, width, height, rootX, pan, ...option }) => <Frame name={name} width={width} height={height} locale="en"
    note="Proposed. Compact capsules grow outward in fixed 152px columns. Horizontal pan is explicit, never task-driven; labels stay under logos.">
    <div data-free class="relative overflow-hidden bg-canvas" style={{ width, height }}>
      <div class="absolute left-0 top-0" style={{ transform: `translateX(-${pan}px)` }}>
        <TopologyScreen width={rootX + 430} height={height} hideNodeLabels scene={{
          nodes: [[width === 390 ? 16 : 24, 100, 1]], tasks: [],
          links: [
            { d: width === 390 ? 'M40 124V292Q40 316 64 316H126' : 'M48 124V314Q48 338 72 338H250',
              class: 'stroke-role-source/55', 'stroke-width': '2' },
            { d: `M${width === 390 ? 200 : 326} ${width === 390 ? 316 : 338}H${rootX - 48}V760 M${rootX - 48} 426H${rootX} M${rootX - 48} 566H${rootX}`,
              class: 'stroke-role-agent/55', 'stroke-width': '2' },
          ],
          mark: { x: width === 390 ? 110 : 250, y: width === 390 ? 263 : 300, size: width === 390 ? 106 : 76,
            sourceAction: false, agentAction: false },
          chrome: [],
          items: [
            { x: rootX - 31, y: 400, content: <TopologyNode label="Codex" brand="codex" readings={quotaReadings}
              taskState={'idle' in option && option.idle ? {} : 'overflow' in option && option.overflow ? overflow : localRunning} capsuleCompact /> },
            { x: 0, y: 0, content: <PortraitDeviceBranch rootX={rootX} state={'state' in option ? option.state : 'lan'} overflow={'overflow' in option && option.overflow} idle={'idle' in option && option.idle} /> },
            { x: rootX - 54, y: 752, content: <DeviceAddEndpoint /> },
          ],
        }} />
      </div>
      <div class="absolute top-[27px] flex justify-center" style={{ left: (width - 240) / 2 }}>
        <HomepageHeader mode="topology" attention={'idle' in option && option.idle || 'state' in option && option.state === 'offline' ? 0 : 'overflow' in option && option.overflow ? 336 : 1} date={copy.date} time={copy.time} title={copy.board} />
      </div>
      <div class="absolute bottom-6 left-6"><NavCapsule active="" /></div>
      <div class="absolute bottom-6 right-6 flex rounded-full bg-surface-raised p-1 shadow-sm">
        <IconButton compact icon="chevron-left" label="Pan topology left" disabled={pan === 0} />
        <IconButton compact icon="chevron-right" label="Pan topology right" disabled={pan >= rootX - 40} />
      </div>
    </div>
  </Frame>),
];
