export function ActivityHeading({ children }: { children: unknown }) { return <div class="text-title leading-6 font-[650]">{children}</div>; }
export function TaskDateHeading({ children }: { children: unknown }) { return <h3 class="py-2 text-meta leading-4 font-semibold text-text-secondary">{children}</h3>; }
import { Frame } from 'adg';
import { Button } from '../components/button';
import { Setting, SettingsSection } from '../components/settings-row';
import { SingleChoice } from '../components/single-choice';
import { Switch } from '../components/switch';
import { Input } from '../components/field';
import { QuotaCards } from '../components/quota';
import { TaskCard } from '../components/task-card';
import { AgentIcon } from '../components/agent-quota-mark';
import { IconButton } from '../components/icon-button';
import { layerSettings, layerTask } from '../fixtures/layer-content';
import { ThemeSwatch } from '../components/theme-swatch';
import { agentQuotas } from '../fixtures/quota';

export function WorkspaceContent({ settings = false }: { settings?: boolean }) {
  if (!settings) return <div class="flex flex-col gap-5 pt-[6px]">
    <div class="flex flex-col gap-3"><h2 class="text-body font-[650] leading-4">Hosted relays</h2>
      <p class="text-body text-text-secondary leading-4">You have not deployed a relay yet.</p></div>
    <div><Button class="w-[186px]">Deploy new relay</Button></div>
  </div>;
  return <div class="flex flex-col gap-7 pt-2">
    {layerSettings.map(section => <SettingsSection title={section.title}>
      {section.rows.map(row => <Setting title={row.label} description={'description' in row ? row.description : undefined} toggle={'toggle' in row} width={'input' in row ? 104 : 300}>
        {row.label === 'Theme color' ? <div class="flex gap-3">{['default','blue','purple','orange','green'].map(value=><ThemeSwatch value={value}/>)}</div>
          : row.label === 'Privacy mode' ? <div class="w-20"><SingleChoice value="hidden" label="Privacy mode" options={[{value:'visible',label:'Show',icon:'eye'},{value:'hidden',label:'Hide',icon:'eye-off'}]} iconOnly compact fill/></div>
          : 'toggle' in row && row.toggle != null ? <Switch checked={row.toggle === 'true'} label={row.label!} />
          : 'input' in row && row.input != null ? <Input value={row.input} class="w-[104px]" />
          : <div class="w-[300px]"><SingleChoice label={row.label!} value={row.options.find(o => o.selected)?.value ?? ''}
            options={row.options} fill /></div>}
      </Setting>)}
    </SettingsSection>)}
  </div>;
}
export function NodePanelContent() {
  return <div class="flex flex-col gap-4"><QuotaCards windows={agentQuotas} />
    <section class="flex flex-col"><TaskDateHeading>今天 · 1</TaskDateHeading>
      <TaskCard task={layerTask} form="detail" /></section>
  </div>;
}
export function NodePanelHeading() {
  return <div class="flex items-center gap-3 w-full"><AgentIcon brand="codex" size={44} readings={agentQuotas.map((quota,index)=>({id:String(index),label:quota.label,value:quota.value,color:`var(--${quota.tone})`,elapsed:quota.elapsed}))}/>
    <div class="flex flex-col flex-1 gap-1"><div class="flex gap-2 h-6 items-center"><h2 class="text-title font-[650] leading-6">Codex</h2><IconButton icon="arrow-up-right" label="Open Agent"/></div>
      <p class="text-meta text-text-secondary leading-4">fixture · 0 个任务进行中</p></div>
    <div class="flex gap-1"><IconButton icon="refresh-cw" label="Refresh"/><IconButton icon="settings" label="Settings"/>
      <IconButton icon="maximize-2" label="Expand"/></div>
  </div>;
}
export default () => <Frame name="workspace-fit" width={912}><WorkspaceContent /></Frame>;
