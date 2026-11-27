import { Frame } from "adg";
import { Maximize2, X } from "lucide-react";
import { LocaleProvider } from "@/i18n/react";
import { IconButton } from "@/components/kit/button";
import {
  AgentPlatformContentView,
  AgentPlatformHeaderView,
} from "@/components/AgentPlatformContentView";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/brand-mark";
import { AccountCard } from "../modules/agent-account";
import {
  platformAccounts,
  platformAccountCopy as copy,
} from "../fixtures/agent-accounts";

function Platform({
  agent,
  state = "ready",
}: {
  agent: typeof platformAccounts.claude;
  state?: "ready" | "empty" | "loading";
}) {
  return (
    <LocaleProvider locale="zh-CN">
      <PanelShell viewportHeight={800} className="overflow-hidden">
        <AgentPlatformContentView
          header={
            <AgentPlatformHeaderView
              brandSlot={<BrandMark brand={agent.brand} size={36} />}
              title={agent.name}
              addAccountLabel={copy.add}
              widthControl={
                <IconButton compact icon={Maximize2} label={copy.expand} />
              }
              closeAction={<IconButton compact icon={X} label={copy.close} />}
            />
          }
          loading={state === "loading"}
          loadingLabel={copy.loading}
          hasAccounts={state === "ready" && agent.accounts.length > 0}
          canLogin
          emptyMessage={copy.empty}
        >
          {state === "ready" && (
            <div className="flex flex-col gap-3 p-5">
              {agent.accounts.map((account) => (
                <AccountCard key={account.alias} account={account} />
              ))}
            </div>
          )}
        </AgentPlatformContentView>
      </PanelShell>
    </LocaleProvider>
  );
}

export default () => [
  <Frame
    key="accounts"
    name="accounts"
    fixture="agent-platform-lifecycle"
    capture={{
      selector: ".dialog:has(.agent-platform-view)",
      viewport: "1280x800",
    }}
  >
    <Platform agent={platformAccounts.claude} />
  </Frame>,
  <Frame
    key="empty"
    name="empty"
    fixture="agent-platform-empty"
    capture={{
      selector: ".dialog:has(.agent-platform-view)",
      viewport: "1280x800",
    }}
  >
    <Platform agent={platformAccounts.claude} state="empty" />
  </Frame>,
  <Frame
    key="loading"
    name="loading"
    fixture="agent-platform-loading"
    capture={{
      selector: ".dialog:has(.agent-platform-view)",
      viewport: "1280x800",
    }}
  >
    <Platform agent={platformAccounts.claude} state="loading" />
  </Frame>,
];
