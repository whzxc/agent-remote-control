import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { CopyField } from "../components/copy-field";
import SourceArt from "../art/source.svg";
import { Tile } from "../components/tile";
const connections = [
  {
    title: "My relay",
    detail: "在线 · ",
    account: "Claude · Personal",
    address: "teatnsestonon.ssthssr.oshranr",
    provider: "Cloudflare Workers",
    method: "中继链接",
    version: "Worker 版本 · fixture",
    icon: "link",
  },
  {
    title: "ChatGPT tunnel",
    detail: "在线",
    provider: "OpenAI Secure Tunnel",
    method: "OpenAI Secure Tunnel",
    icon: "shield",
  },
];
export default () => (
  <Frame
    name="overview"
    fixture="p3-workspace-add-light"
    capture={{ region: "连接", viewport: "1280x800" }}
  >
    <PanelShell width={680} class="px-6 pt-[13px] pb-6 gap-[25px]">
      <PanelHeader
        title="连接"
        actions={
          <Button variant="primary" icon="plus">
            添加连接
          </Button>
        }
      />
      <div class="flex flex-col gap-4">
        {connections.map((c) => (
          <article
            class={`flex flex-col gap-5 rounded-card bg-surface-subtle px-4 pt-4 ${c.address ? "pb-[14px]" : "pb-[18px]"}`}
          >
            <header class="flex h-10 items-center gap-3">
              <Tile icon={c.icon} tone={c.address ? "accent" : "command"} />
              <div class="flex flex-1 flex-col gap-1 pt-[6px]">
                <strong class="text-body leading-[18px] font-[650]">
                  {c.title}
                </strong>
                <div class="flex items-center gap-[6px] text-meta leading-4 text-text-secondary">
                  <span class="size-[6px] rounded-full bg-success" />
                  <span class="text-success">{c.detail}</span>
                  {c.account && (
                    <>
                      <SourceArt
                        data-brand
                        width={18}
                        height={18}
                        class="text-role-source"
                      />
                      <span>{c.account}</span>
                    </>
                  )}
                </div>
              </div>
              {!c.address && <IconButton icon="pencil" label="Edit tunnel" />}
              <IconButton icon="trash-2" label={`Delete ${c.title}`} />
            </header>
            {c.address && (
              <div class="-mt-1">
                <CopyField value={c.address} masked />
              </div>
            )}
            <div
              class={`grid grid-cols-2 gap-3 ${c.address ? "-mt-[2px]" : ""}`}
            >
              {[
                { label: "服务提供商", value: c.provider },
                { label: "连接方式", value: c.method },
              ].map((item) => (
                <div class="flex flex-col gap-2">
                  <span class="text-meta leading-4 text-text-secondary">
                    {item.label}
                  </span>
                  <span class="text-small leading-4">{item.value}</span>
                </div>
              ))}
            </div>
            {c.version && (
              <span class="-mt-[10px] text-meta leading-4 text-text-tertiary">
                {c.version}
              </span>
            )}
          </article>
        ))}
      </div>
    </PanelShell>
  </Frame>
);
