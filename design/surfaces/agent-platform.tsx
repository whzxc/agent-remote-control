import { NativeAgentInfo } from "../modules/agent-settings";
import { Frame } from "sdg";
import { PanelShell } from "../components/panel";
import { BrandMark } from "../components/agent-icon";
import { IconButton } from "../components/icon-button";
import { QuotaSummary } from "../modules/quota";
import { quotaAccounts as accounts } from "../fixtures/quota";
import { accountManagement as copy } from "../fixtures/agent-account-management";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Tag } from "../components/tag";
function Platform({ native = false }: { native?: boolean }) {
  return (
    <PanelShell width={480} height={590} class="p-5">
      <header class="flex h-9 items-center gap-4">
        <BrandMark brand={native ? "antigravity" : "claude-code"} size={36} />
        <h2 class="flex-1 text-title font-[650]">{native ? "Antigravity" : "Claude Code"}</h2>
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

type ManagementAgent = typeof copy.claude | typeof copy.codex;

function AccountManagement({ agent, empty = false }: { agent: ManagementAgent; empty?: boolean }) {
  return (
    <PanelShell width={480} class="gap-6 p-5">
      <header class="flex items-center gap-3">
        <BrandMark brand={agent.brand} size={36} />
        <div class="flex min-w-0 flex-1 flex-col gap-1">
          <h2 class="text-title font-[650] leading-6">{copy.title}</h2>
          <p class="text-meta leading-4 text-text-secondary">{agent.name}</p>
        </div>
        <Button icon="plus" variant="primary">{copy.add}</Button>
        <IconButton icon="x" label={copy.close} />
      </header>
      {empty ? (
        <Card padded>
          <p class="text-small text-text-secondary">{copy.empty}</p>
        </Card>
      ) : (
        <div class="flex flex-col gap-3">
          {agent.rows.map((row) => (
            <Card padded>
              <div class="flex items-center gap-2">
                <div class="flex min-w-0 flex-1 flex-col gap-1">
                  <div class="flex flex-wrap items-center gap-2">
                    <h3 class="truncate text-body font-semibold">{row.name}</h3>
                    {"default" in row && row.default && <Tag form="meta">{copy.default}</Tag>}
                  </div>
                  <p class={`text-meta leading-4 ${row.state === "signed-in" ? "text-success" : "text-danger"}`}>
                    {row.state === "signed-in" ? copy.signedIn : row.state === "native-signed-out"
                      ? `${copy.native} · ${copy.signedOut}` : copy.signedOut}
                  </p>
                </div>
                {row.state === "signed-out" && <Button variant="primary">{copy.reauth}</Button>}
                {row.state === "native-signed-out" && <Button variant="primary">{copy.openCodex}</Button>}
                {row.state === "signed-in" && <IconButton icon="refresh-cw" label={copy.refresh} />}
                <IconButton icon="ellipsis" label={`${row.name} · ${copy.more}`} />
              </div>
              {"quotas" in row ? <div class="grid grid-cols-2 gap-2">
                {row.quotas.map(q => <QuotaSummary {...q} />)}
              </div> : row.state === "signed-in" && <p class="text-meta text-text-secondary">{copy.quotaUnavailable}</p>}
            </Card>
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
    note={
      "Prepared in the adapter. The implementation follows topology panel geometry; its width is not " +
      "fixed to the drawing's 480px."
    }
  >
    <Platform />
  </Frame>,
  <Frame
    name="native"
    note={
      "Unavailable: zero-account platforms open Agent history. antigravity-platform has no linked " +
      "accounts, so the native empty card cannot be reached through that route."
    }
  >
    <Platform native />
  </Frame>,
  <Frame name="manage-claude" note="Proposed account list and sign-in recovery. Runtime fixture pending adoption.">
    <AccountManagement agent={copy.claude} />
  </Frame>,
  <Frame name="manage-codex-primary" note="Proposed native primary account recovery. Runtime fixture pending adoption.">
    <AccountManagement agent={copy.codex} />
  </Frame>,
  <Frame name="manage-empty" note="Proposed zero-account entry. Runtime fixture pending adoption.">
    <AccountManagement agent={copy.claude} empty />
  </Frame>,
];
