import { Frame } from "adg";
import { McpHub } from "../modules/mcp-service";
export default () =>
  ["ready", "failed", "empty"].map((name) => (
    <Frame
      name={name} width={1280} height={1200}
      fixture={`mcp-hub-${name}-dark`}
      capture={{ region: "MCP 中枢", viewport: "1280x1200" }}
      note="XL center slot with content-fit height, capped at the bottom margin; the header stays fixed and the body scrolls."
    >
      <McpHub form={name} workspace />
    </Frame>
  ));
