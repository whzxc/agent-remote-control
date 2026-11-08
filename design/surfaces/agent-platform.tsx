import { NativeAgentInfo } from "../modules/agent-settings";
import { Frame } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaSummary } from "../modules/quota";
import { quotaAccounts as accounts } from "../fixtures/quota";
function Platform({ native = false }: { native?: boolean }) {
  return (
    <PanelShell width={480} height={590} class="p-5">
      <header class="flex h-9 items-center gap-4">
        <BrandMark brand={native ? "antigravity" : "claude-code"} size={36} />
        <h2 class="flex-1 text-title font-[650]">
          {native ? "Antigravity" : "Claude Code"}
        </h2>
        <div class="flex gap-[6px]">
          <IconButton icon="maximize-2" label="Expand" />
          <IconButton icon="x" label="Close" />
        </div>
      </header>
      {native ? (
        <NativeAgentInfo />
      ) : (
        <div class="mt-8 flex flex-col gap-7">
          {accounts.map((account) => (
            <section class="flex flex-col gap-4">
              <div class="flex h-5 items-center gap-3">
                <h3 class="text-body font-semibold">{account.name}</h3>
                <IconButton compact icon="refresh-cw" label={account.name} />
              </div>
              <div class="grid grid-cols-2 gap-2">
                {account.quotas.map((q) => (
                  <QuotaSummary {...q} tall />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PanelShell>
  );
}
export default () => [
  <Frame
    name="accounts"
    fixture="agent-platform-accounts"
    capture={{
      selector: ".dialog:has(.agent-platform-view)",
      viewport: "1280x800",
    }}
    note="Prepared in the adapter. The implementation follows topology panel geometry; its width is not fixed to the drawing's 480px."
  >
    <Platform />
  </Frame>,
  <Frame
    name="native"
    note="Unavailable: zero-account platforms open Agent history. antigravity-platform has no linked accounts, so the native empty card cannot be reached through that route."
  >
    <Platform native />
  </Frame>,
];
