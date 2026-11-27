import type { ReactNode } from "react";
export function ActivityHeading({ children }: { children: ReactNode }) { return <div className="text-title leading-6 font-[650]">{children}</div>; }
export function TaskDateHeading({ children }: { children: ReactNode }) { return <h3 className="py-2 text-meta leading-4 font-semibold text-text-secondary">{children}</h3>; }
import { Frame } from 'adg';
import { Button } from '../components/button';
import { QuotaCards } from '../components/quota';
import { TaskCard } from '../components/task-card';
import { layerTask } from '../fixtures/layer-content';
import { agentQuotas } from '../fixtures/quota';

export function WorkspaceContent() {
  return <div className="flex flex-col gap-5 pt-[6px]">
    <div className="flex flex-col gap-3"><h2 className="text-body font-[650] leading-4">Hosted relays</h2>
      <p className="text-body text-text-secondary leading-4">You have not deployed a relay yet.</p></div>
    <div><Button anchor="deploy-relay" className="w-[186px]">Deploy new relay</Button></div>
  </div>;
}
export function NodePanelContent() {
  return <div className="flex flex-col gap-4"><QuotaCards windows={agentQuotas} />
    <section className="flex flex-col"><TaskDateHeading>今天 · 1</TaskDateHeading>
      <TaskCard task={layerTask} form="detail" /></section>
  </div>;
}
export default () => <Frame name="workspace-fit" width={912}><WorkspaceContent /></Frame>;
