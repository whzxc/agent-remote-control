import { Frame } from 'adg';
import { DevicesWorkspace } from '../modules/device-link';
import { locales, workspaceStates } from '../fixtures/device-link';

export default () => locales.flatMap(locale => workspaceStates.map(state =>
  <Frame name={`${state}-${locale}`} width={720}
    fixture={`device-${state}-${locale}-light`} capture={{ selector: ".devices-workspace", viewport: "1280x800" }}>
    <DevicesWorkspace locale={locale} state={state} />
  </Frame>,
));
