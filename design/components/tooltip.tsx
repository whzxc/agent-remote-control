import type { ReactNode } from "react";
import { Frame } from "adg";
import { tooltipExample } from "../fixtures/feedback";

export function Tooltip({
  text,
  children, open = false,
}: {
  text?: ReactNode;
  children?: ReactNode;
  open?: boolean;
}) {
  if (!open) return <span title={String(text ?? '')} className="contents">{children}</span>;
  return (
    <div
      role="tooltip"
      className="inline-flex items-center px-3 py-2 rounded-tile bg-action text-on-action shadow-md text-meta leading-[14px] font-medium"
    >
      {text ?? children}
    </div>
  );
}
export default () => (
  <Frame name="default">
    <Tooltip open>{tooltipExample}</Tooltip>
  </Frame>
);
