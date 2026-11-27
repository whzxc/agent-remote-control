import { Frame, Icon } from "adg";
import ClaudeCodeArt from "../art/claude-code.svg";
import CodexArt from "../art/codex.svg";
import OpenaiArt from "../art/openai.svg";
import AnthropicArt from "../art/anthropic.svg";
import GoogleArt from "../art/google.svg";
import XaiArt from "../art/xai.svg";
import MicrosoftArt from "../art/microsoft.svg";
import NotionArt from "../art/notion.svg";
import SlackArt from "../art/slack.svg";
import RaycastArt from "../art/raycast.svg";
import CursorArt from "../art/cursor.svg";
import OpencodeArt from "../art/opencode.svg";
import AlibabaArt from "../art/alibaba.svg";
import ClaudeArt from "../art/claude.svg";
import DeepseekArt from "../art/deepseek.svg";
import PiArt from "../art/pi.svg";
import AntigravityArt from "../art/antigravity.svg";
import { iconExampleBrand } from "../fixtures/agent-icons";

const brands = {
  antigravity: AntigravityArt,
  claude: ClaudeArt,
  deepseek: DeepseekArt,
  pi: PiArt,
  "claude-code": ClaudeCodeArt,
  codex: CodexArt,
  openai: OpenaiArt,
  anthropic: AnthropicArt,
  google: GoogleArt,
  xai: XaiArt,
  microsoft: MicrosoftArt,
  notion: NotionArt,
  slack: SlackArt,
  raycast: RaycastArt,
  cursor: CursorArt,
  opencode: OpencodeArt,
  alibaba: AlibabaArt,
};
export type Brand = keyof typeof brands;

export function BrandMark({
  brand,
  size = 40,
}: {
  brand?: Brand;
  size?: number;
}) {
  const Artwork = brand && brands[brand];
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center text-text"
      style={{ width: size, height: size }}
    >
      {Artwork ? (
        <Artwork data-brand width={size} height={size} />
      ) : (
        <Icon name="bot" size={size} />
      )}
    </span>
  );
}
export default () => <Frame name="brand-mark"><BrandMark brand={iconExampleBrand} size={38} /></Frame>;
