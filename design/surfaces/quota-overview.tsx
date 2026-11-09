import { Frame } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaCards } from "../modules/quota";
import { Tile } from "../components/tile";
import { Button } from "../components/button";
import { agentQuotas, overviewProvider } from "../fixtures/quota";
function QuotaOverview({ empty = false }: { empty?: boolean }) {
  return (
    <PanelShell width={440} class="px-6 pt-[13px] pb-6">
      <PanelHeader
        title="订阅额度"
        actions={!empty && <IconButton icon="refresh-cw" label="Refresh" />}
      />
      {empty ? (
        <div class="mt-[33px] flex flex-col items-center">
          <Tile icon="gauge" tone="neutral" />
          <p class="mt-[14px] text-small leading-4 text-text-tertiary">
            暂无已启用的订阅来源
          </p>
          <div class="mt-[18px]">
            <Button class="px-[21px]">设置</Button>
          </div>
        </div>
      ) : (
        <div class="mt-6 flex flex-col gap-3">
          <header class="flex h-6 items-center gap-[10px]">
            <BrandMark brand="codex" size={24} />
            <strong class="text-body font-[650]">{overviewProvider.name}</strong>
            <span class="text-meta text-text-tertiary">{overviewProvider.observed}</span>
          </header>
          <QuotaCards windows={agentQuotas} />
        </div>
      )}
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="overview"
    fixture="quota-overview"
    capture={{
      selector: ".dialog:has(.usage-overview)",
      viewport: "1280x800",
      clicks: ["管理 Agent", "订阅额度"],
    }}
  >
    <QuotaOverview />
  </Frame>,
  <Frame
    name="empty"
    fixture="settings-about-dark"
    capture={{
      selector: ".dialog:has(.usage-overview)",
      viewport: "1280x800",
      clicks: ["返回首页", "管理 Agent", "订阅额度"],
    }}
  >
    <QuotaOverview empty />
  </Frame>,
];
