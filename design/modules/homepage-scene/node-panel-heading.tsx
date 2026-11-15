import { TopologyNode } from './topology-node';
import { AgentIcon } from './agent-icon';
import { agentQuotas } from '../../fixtures/quota';
import { IconButton } from '../../components/icon-button';

export function NodePanelHeading() {
  return <div class="flex items-center gap-3 w-full"><TopologyNode bare label="Codex" graphic={<AgentIcon brand="codex" size={44} readings={agentQuotas.map((quota,index)=>({id:String(index),label:quota.label,value:quota.value,color:`var(--${quota.tone})`,elapsed:quota.elapsed}))}/>}/>
    <div class="flex flex-col flex-1 gap-1"><div class="flex gap-2 h-6 items-center"><h2 class="text-title font-[650] leading-6">Codex</h2><IconButton icon="arrow-up-right" label="Open Agent"/></div>
      <p class="text-meta text-text-secondary leading-4">fixture · 0 个任务进行中</p></div>
    <div class="flex gap-1"><IconButton icon="refresh-cw" label="Refresh"/><IconButton icon="settings" label="Settings"/>
      <IconButton icon="maximize-2" label="Expand"/></div>
  </div>;
}
