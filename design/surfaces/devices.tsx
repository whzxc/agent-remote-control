import { Frame } from 'adg';
import { DevicesWorkspace } from '../modules/device-link';
import { locales, workspaceStates } from '../fixtures/device-link';

export default () => locales.flatMap(locale => workspaceStates.map(state =>
  <Frame name={`${state}-${locale}`} width={720}
    note="Approved. Shared workspace width. Desktop browser fixture pending implementation; all data is synthetic.">
    <DevicesWorkspace locale={locale} state={state} />
  </Frame>,
));
