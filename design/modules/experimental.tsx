import { copy } from '../fixtures/experimental';
import { DeviceExperiment } from './device-link';



import { SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { Frame } from "adg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { experiments } from '../fixtures/experimental';
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
export default () => [
  <Frame name="experimental-content" width={672}>
    <div class="w-full bg-surface-raised"><ExperimentalContent  /></div>
  </Frame>,
];
