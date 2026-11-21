import { Frame, Icon } from "adg";
import { PanelShell, PanelHeader } from "../components/panel";
import { BrandMark } from "../components/brand-mark";
import { IconButton } from "../components/icon-button";
import { QuotaCards } from '../components/quota';
import { Tile } from "../components/tile";
import { Button } from "../components/button";
import { antigravityQuotaOverview } from "../fixtures/quota";

function QuotaOverview({ empty = false }: { empty?: boolean }) {
  return (
    <PanelShell class="px-6 pt-[13px] pb-6">
      <PanelHeader
        title="订阅额度"
        actions={!empty && <IconButton icon="refresh-cw" label="刷新" />}
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
        <div class="mt-[25px]">
          <QuotaCards windows={antigravityQuotaOverview.windows} heading={
            <header class="flex items-center gap-2.5 border-b border-border py-3">
              <BrandMark brand="antigravity" size={26} />
              <strong class="text-body font-[650]">{antigravityQuotaOverview.name}</strong>
              <span class="ml-auto inline-flex items-center gap-1.5 text-meta text-text-secondary">
                <Icon name="refresh-cw" size={13} />{antigravityQuotaOverview.observed}
              </span>
            </header>
          } />
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
