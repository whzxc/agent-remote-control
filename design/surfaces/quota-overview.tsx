import { Frame, Icon } from "sdg";
import { PanelShell, PanelHeader } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaBar } from "../components/quota-card";
import { Tile } from "../components/tile";
import { Button } from "../components/button";
const readings = [
  {
    title: "5h 额度 · 剩余 27%",
    detail: "2h 0m · ≈ 1h 7m",
    remaining: 27,
    elapsed: 0.4,
  },
  {
    title: "周额度 · 剩余 32%",
    detail: "3d 0h · ≈ 1d 21h",
    remaining: 32,
    elapsed: 3 / 7,
  },
];
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
        <div class="mt-[33px] flex flex-col gap-7 rounded-card bg-surface-subtle p-4 pb-[18px]">
          <header class="flex h-6 items-center gap-[10px]">
            <BrandMark brand="codex" size={24} />
            <strong class="text-body font-[650]">ChatGPT</strong>
            <span class="text-meta text-text-tertiary">· 2m ago</span>
          </header>
          <div class="flex flex-col gap-[22px]">
            {readings.map((q) => (
              <div class="flex flex-col gap-2">
                <span class="text-meta leading-4 text-text-secondary">
                  {q.title}
                </span>
                <QuotaBar remaining={q.remaining} elapsed={q.elapsed} />
                <span class="mt-1 text-meta leading-4 text-text-secondary">
                  {q.detail}
                </span>
              </div>
            ))}
          </div>
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
