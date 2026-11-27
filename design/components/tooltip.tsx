import { isValidElement, type ReactNode } from "react";
import { Frame } from "adg";
import { HintTooltip } from "@/components/kit";
import { tooltipExample } from "../fixtures/feedback";

export function Tooltip({
  text,
  children,
  open = false,
}: {
  text?: ReactNode;
  children?: ReactNode;
  open?: boolean;
}) {
  if (!open) {
    if (isValidElement(children) && text) {
      return <HintTooltip text={text}>{children}</HintTooltip>;
    }
    return <span title={String(text ?? "")} className="contents">{children}</span>;
  }
  return (
    <div
      role="tooltip"
      data-slot="tooltip-popup"
      className="inline-flex w-max max-w-[300px] items-center wrap-break-word rounded-kit-field bg-action px-2 py-1 text-meta font-medium leading-4 text-on-action shadow-md"
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
