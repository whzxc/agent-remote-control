import { copy, experiments } from '../fixtures/experimental';
import { SettingsToggleRows as ToggleRows, SettingLine } from '../components/settings-row';
import { Frame } from 'adg';
import { Panel } from '../components/panel';
import { Card } from '../components/card';
import { IconButton } from '../components/icon-button';
import { Switch } from '../components/switch';
import { deviceCopy, type DeviceLocale } from '../fixtures/device-link';

export function ExperimentalContent() {
  return (<div class="flex flex-col gap-6 pt-2">
        <DeviceExperiment locale="en" enabled={false} />
        {[experiments.slice(0, 3), experiments.slice(3)].map((rows) => (
          <Card class="gap-0! py-0!">
            <ToggleRows rows={rows.map(row => ({ ...row, description: row.description.join(" ") }))} />
          </Card>
        ))}
      </div>);
}

export function Experimental({ workspace = false }: { workspace?: boolean } = {}) {
  return (
    <Panel viewportHeight={workspace ? 800 : undefined}
      leading={<IconButton icon="arrow-left" label={copy.text1} />}
      title={<>{copy.text2.split(" / ").map((part, index) => <>{index > 0 && <span aria-hidden="true"> / </span>}<span>{part}</span></>)}</>}
      actions={<IconButton icon="maximize-2" label={copy.text3} />}
    >
      <ExperimentalContent  />
    </Panel>
  );
}

const experimentalFrames = () => [
  <Frame name="experimental-content" width={672}>
    <div class="w-full bg-surface-raised"><ExperimentalContent  /></div>
  </Frame>,
];


type Localized = { locale: DeviceLocale };

export function DeviceExperiment({ locale, enabled }: Localized & { enabled: boolean }) {
  const c = deviceCopy[locale];
  return <Card class="py-0! gap-0!">
    <SettingLine title={c.deviceLink}><Switch checked={enabled} label={c.deviceLink} /></SettingLine>
  </Card>;
}

const device_experimentFrames = () => [false, true].map(enabled => <Frame name={`device-experiment-${enabled ? 'on' : 'off'}`} width={672}
 fixture={`device-experiment-${enabled ? 'on' : 'off'}-en@light`} capture={{ selector: '.device-experiment', viewport: '1280x800' }}><DeviceExperiment locale="en" enabled={enabled} /></Frame>);

export default () => [...[experimentalFrames()].flat(), ...[device_experimentFrames()].flat()];
