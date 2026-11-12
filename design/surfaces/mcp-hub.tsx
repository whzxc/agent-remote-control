import { Frame } from "adg";
import { McpHub } from "../modules/mcp-service";
export default () =>
  ["ready", "failed", "empty"].map((name) => (
    <Frame
      name={name}
      fixture={`mcp-hub-${name}-dark`}
      capture={{ selector: ".layer-panel", viewport: "1280x1200", ...(name === "ready" ? { clicks: ["3 个工具"] } : {}) }}
      note="XL center slot with content-fit height, capped at the bottom margin; the header stays fixed and the body scrolls."
    >
      <McpHub form={name} workspace />
    </Frame>
  ));
