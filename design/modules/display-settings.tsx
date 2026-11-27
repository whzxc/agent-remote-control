import {InspectionPopover} from '../components/inspection-popover';
import {SingleChoice} from '../components/single-choice';
import {Button} from '../components/button';

import { copy, samples } from '../fixtures/display-settings';


import { SettingsChoices as Choices, SettingsGroup as Group } from "../components/settings-row";
import { Frame } from "adg";
import { Dialog } from "../components/panel";

import { SettingLine } from "../components/settings-row";
import { Switch } from "../components/switch";


export function DisplayContent() {
  return (<div className="flex flex-col gap-[30px] pt-2">
        <Group title={copy.text19}>
          <SettingLine title={copy.text23}>
            <Choices
              label={copy.text24}
              options={samples.sample25}
              value={copy.text26}
              width={200}
            />
          </SettingLine>
        </Group>
        <Group title={copy.text27}>
          <SettingLine title={copy.text28}>
            <Switch checked={false} label={copy.text29} />
          </SettingLine>
          <SettingLine title={copy.text30}>
            <Choices
              label={copy.text31}
              options={samples.sample32}
              width={220}
            />
          </SettingLine>
          <SettingLine title={copy.text33}>
            <Choices
              label={copy.text34}
              options={samples.sample35}
              dropdown
            />
          </SettingLine>
          <SettingLine title={copy.text36}>
            <Choices
              label={copy.text37}
              options={samples.sample38}
              value=""
            />
          </SettingLine>
        </Group>
      </div>);
}

export function Display() {
  return (
    <Dialog viewportHeight={1080} title={copy.text39}>
      <DisplayContent  />
    </Dialog>
  );
}
export default () => [
  <Frame name="studio-settings" width={316}><StudioSettings/></Frame>,
  <Frame name="display-content" width={672}>
    <div className="w-full bg-surface-raised"><DisplayContent  /></div>
  </Frame>,
];

function StudioSettings() {return <InspectionPopover variant="studio" className="grid gap-4 w-[316px] p-[18px] border border-border rounded-panel bg-surface text-text shadow-md"><SingleChoice label="Lighting" value="day" options={[{value:'day',label:'Day',icon:'sun'},{value:'night',label:'Night',icon:'moon'}]}/><Button icon="expand">Fullscreen</Button></InspectionPopover>;}
