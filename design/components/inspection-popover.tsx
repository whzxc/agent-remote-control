import {Frame} from 'adg';
export function InspectionPopover({children,class:extra="",variant='tuning'}:{children:unknown;class?:string;variant?:'pet'|'studio'|'tuning'|'model'}) {
  return <div class={extra || `rounded-panel border border-border ${variant==='tuning'?'bg-surface-raised':'bg-surface'} text-text shadow-md p-3 text-meta`}>{children}</div>;
}
export default ()=><Frame name="surface" width={320}><InspectionPopover>Display settings</InspectionPopover></Frame>;
