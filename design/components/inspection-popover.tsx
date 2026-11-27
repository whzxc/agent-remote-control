import type { ReactNode } from "react";
import {Frame} from 'adg';
export function InspectionPopover({children,className:extra="",variant='tuning'}:{children:ReactNode;className?:string;variant?:'pet'|'studio'|'tuning'|'model'}) {
  return <div className={extra || `rounded-panel border border-border ${variant==='tuning'?'bg-surface-raised':'bg-surface'} text-text shadow-md p-3 text-meta`}>{children}</div>;
}
export default ()=><Frame name="surface" width={320}><InspectionPopover>Display settings</InspectionPopover></Frame>;
