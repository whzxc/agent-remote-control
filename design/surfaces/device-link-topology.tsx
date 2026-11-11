import { Frame } from 'adg';
import { TopologyScreen } from '../modules/homepage-topology';
import { DeviceNavigation, DeviceTopologyEntry } from '../modules/device-link';
import { scenes } from '../fixtures/topology';
import { deviceCopy, locales, topologyOptions, topologyPlacement } from '../fixtures/device-link';

export default () => locales.flatMap(locale => topologyOptions.map(option => {
  const c = deviceCopy[locale];
  const scene = {
    ...scenes['empty-empty'],
    chrome: scenes['empty-empty'].chrome.filter(item => item.kind !== 'nav').map(item =>
      item.kind === 'board' ? { ...item, title: c.board, date: c.date } :
        item.kind === 'button' ? { ...item, label: c.addConnection } : item),
  };
  const position = topologyPlacement[option];
  return <Frame name={`${option}-${locale}`} width={1280} height={800}
    note={option === 'summary'
      ? 'Open decision A (recommended): one summary chip opens Devices. Existing ARC mark, earcups and branches remain intact.'
      : 'Open decision B: compact member roster opens device details. No member Agent branches or multihop links.'}>
    <TopologyScreen width={1280} height={800} scene={scene}>
      <div data-free class="absolute inset-0">
        <div class="absolute flex justify-center w-[240px]" style={{ left: position.x, top: position.y }}>
          <DeviceTopologyEntry locale={locale} option={option} />
        </div>
        <div class="absolute left-6 bottom-6"><DeviceNavigation locale={locale} /></div>
      </div>
    </TopologyScreen>
  </Frame>;
}));
