import { Frame } from 'adg';
import { DevicesWorkspace } from '../modules/device-link';
import { locales, workspaceStates } from '../fixtures/device-link';

export default () => locales.flatMap(locale => workspaceStates.map(state =>
  <Frame name={`${state}-${locale}`}
    fixture={`device-${state}-${locale}-light`} capture={{ selector: ".layer-panel.devices-workspace", viewport: "1280x800" }}>
    <DevicesWorkspace locale={locale} state={state} workspace />
  </Frame>,
));
