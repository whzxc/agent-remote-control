import { Frame } from "sdg";
import { PanelLoading, PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { NativeAgentInfo } from "../modules/agent-settings";
import { AccountCard } from "../modules/agent-account";
import { platformAccounts, platformAccountCopy as copy } from "../fixtures/agent-accounts";

function Platform({ agent, state = "ready" }: {
  agent: typeof platformAccounts.claude | typeof platformAccounts.codex;
  state?: "ready" | "empty" | "loading";
}) {
  return (
    <PanelShell width={480} class="max-h-[768px] gap-5 overflow-hidden pt-5">
      <header class="mx-5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2">
        <BrandMark brand={agent.brand} size={36} />
        <h2 class="flex-1 text-title font-[650]">{agent.name}</h2>
        <div class="ml-auto flex items-center gap-1">
          <Button icon="plus">{copy.add}</Button>
          <IconButton icon="maximize-2" label={copy.expand} />
          <IconButton icon="x" label={copy.close} />
        </div>
      </header>
      <div class="min-h-0 overflow-y-auto px-5 pb-5">
        {state === "loading" ? <PanelLoading label={copy.loading} /> : state === "empty" ? (
          <p class="py-8 text-center text-small text-text-secondary">{copy.empty}</p>
        ) : (
          <div class="flex flex-col gap-3">
            {agent.accounts.map(account => <AccountCard account={account} />)}
          </div>
        )}
      </div>
    </PanelShell>
  );
}

function NativePlatform() {
  return (
    <PanelShell width={480} height={590} class="p-5">
      <header class="flex h-9 items-center gap-4">
        <BrandMark brand="antigravity" size={36} />
        <h2 class="flex-1 text-title font-[650]">Antigravity</h2>
        <div class="flex gap-[6px]">
          <IconButton icon="maximize-2" label="Expand" />
          <IconButton icon="x" label="Close" />
        </div>
      </header>
      <NativeAgentInfo />
    </PanelShell>
  );
}

export default () => [
  <Frame name="accounts" fixture="agent-platform-lifecycle"
    capture={{ selector: ".dialog:has(.agent-platform-view)", viewport: "1280x800" }}>
    <Platform agent={platformAccounts.claude} />
  </Frame>,
  <Frame name="single-account" fixture="agent-platform-single"
    capture={{ selector: ".dialog:has(.agent-platform-view)", viewport: "1280x800" }}>
    <Platform agent={platformAccounts.codex} />
  </Frame>,
  <Frame name="empty" fixture="agent-platform-empty"
    capture={{ selector: ".dialog:has(.agent-platform-view)", viewport: "1280x800" }}>
    <Platform agent={platformAccounts.claude} state="empty" />
  </Frame>,
  <Frame name="loading" fixture="agent-platform-loading"
    capture={{ selector: ".dialog:has(.agent-platform-view)", viewport: "1280x800" }}>
    <Platform agent={platformAccounts.claude} state="loading" />
  </Frame>,
  <Frame name="native" note="Unavailable: zero-account native platforms currently open Agent history.">
    <NativePlatform />
  </Frame>,
];
