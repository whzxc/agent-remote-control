import { Frame } from "adg";
import { tooltipExample } from "../fixtures/feedback";

export function Tooltip({
  text,
  children, open = false,
}: {
  text?: unknown;
  children?: unknown;
  open?: boolean;
}) {
  if (!open) return <span title={String(text ?? '')} class="contents">{children}</span>;
  return (
    <div
      role="tooltip"
      class="inline-flex items-center px-3 py-2 rounded-tile bg-tooltip text-on-tooltip shadow-md text-meta leading-[14px] font-medium"
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
