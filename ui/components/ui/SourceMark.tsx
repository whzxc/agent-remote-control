import type { ReactNode } from "react";
import { Tooltip } from "./index";
import "./SourceMark.css";

export function SourceMark({ label, inline, children }: { label: string; inline?: boolean; children: ReactNode }) {
  return <Tooltip text={label}><span className={inline ? "activity-source-mark" : "activity-source-badge"} role="img" aria-label={label}>{children}</span></Tooltip>;
}
