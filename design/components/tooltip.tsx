import { Frame } from "sdg";
const example = "权限与就绪";
export function Tooltip({
  text,
  children,
}: {
  text?: unknown;
  children?: unknown;
}) {
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
    <Tooltip>{example}</Tooltip>
  </Frame>
);
