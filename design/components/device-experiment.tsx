import { Frame } from 'adg';
import { Card } from './card';
import { SettingLine } from './settings-row';
import { Switch } from './switch';
import { deviceCopy, type DeviceLocale } from '../fixtures/device-link';
type Localized = { locale: DeviceLocale };


export function DeviceExperiment({ locale, enabled }: Localized & { enabled: boolean }) {
  const c = deviceCopy[locale];
  return <Card class="py-0! gap-0!">
    <SettingLine title={c.deviceLink}><Switch checked={enabled} label={c.deviceLink} /></SettingLine>
  </Card>;
}
export default () => [false, true].map(enabled => <Frame name={`device-experiment-${enabled ? 'on' : 'off'}`} width={672}
 fixture={`device-experiment-${enabled ? 'on' : 'off'}-en@light`} capture={{ selector: '.device-experiment', viewport: '1280x800' }}><DeviceExperiment locale="en" enabled={enabled} /></Frame>);
