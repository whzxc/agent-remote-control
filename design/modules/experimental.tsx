import { copy } from '../fixtures/experimental';



import { SettingsToggleRows as ToggleRows } from "../components/settings-row";
import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { experiments } from '../fixtures/experimental';
export function ExperimentalContent() {
  return (<div class="flex flex-col gap-6 pt-2">
        {[experiments.slice(0, 3), experiments.slice(3)].map((rows) => (
          <Card class="gap-0! py-0!">
            <ToggleRows rows={rows} />
          </Card>
        ))}
      </div>);
}

export function Experimental() {
  return (
    <Panel
      width={720}
      title={
        <div class="flex items-center gap-[6px]">
          <IconButton icon="arrow-left" label={copy.text1} />{copy.text2}</div>
      }
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
