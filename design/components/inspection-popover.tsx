import {Frame} from 'adg';
export function InspectionPopover({children}:{children:unknown}){return <div class="rounded-panel border border-border bg-surface-raised text-text shadow-md p-3 text-meta">{children}</div>}
export default ()=><Frame name="surface" width={320}><InspectionPopover>Display settings</InspectionPopover></Frame>;
