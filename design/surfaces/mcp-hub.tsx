import { Frame } from "adg";
import { McpHub } from "../modules/mcp-service";
export default () =>
  ["ready", "failed", "empty"].map((name) => (
    <Frame
      name={name}
      fixture={`mcp-hub-${name}-dark`}
      capture={{ region: "MCP 中枢", viewport: "1280x1200" }}
      note={
        "The implementation uses full workspace height. Its shell follows the viewport; the older " +
        "content-fit heights (662, 912 and 432px) are not capture-size requirements."
      }
    >
      <McpHub form={name} />
    </Frame>
  ));
