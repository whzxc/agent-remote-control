import { Frame } from "sdg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { Panel } from "../components/panel";
import { Tag } from "../components/tag";
import { platformAccountCopy as copy, platformAccounts } from "../fixtures/agent-accounts";
import { QuotaCards, type QuotaWindow } from "./quota";

export type AgentAccount = { name: string; default?: boolean; owner?: "desktop" } & (
  | { state: "signed-in"; windows: readonly QuotaWindow[] }
  | { state: "signed-out" }
);

export function AccountCard({ account }: { account: AgentAccount }) {
  const native = account.owner === "desktop";
  const signedIn = account.state === "signed-in";
  return (
    <Card padded variant="reply" class="gap-3! border border-border">
      <div class="flex flex-wrap items-center justify-between gap-x-2">
        <div class="flex min-w-0 flex-col">
          <div class="flex items-center gap-2">
            <h3><Button variant="link">{account.name}</Button></h3>
            {account.default && <Tag form="meta">{copy.default}</Tag>}
          </div>
          {native && <p class="text-meta text-text-secondary">{copy.native}</p>}
          {!signedIn && <p class="text-meta text-danger">{copy.signedOut}</p>}
          {signedIn && !account.windows.length && <p class="text-meta text-text-secondary">{copy.quotaUnavailable}</p>}
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-1">
          {signedIn && <IconButton compact icon="refresh-cw" label={copy.refresh} />}
          <Button variant={signedIn ? "ghost" : "secondary"}>{native ? copy.openCodex : copy.reauth}</Button>
          {!native && <IconButton compact icon="trash-2" label={copy.remove} />}
        </div>
      </div>
      {signedIn && account.windows.length > 0 && <QuotaCards windows={account.windows} />}
    </Card>
  );
}

export function RemoveAccount() {
  return (
    <Panel width={440} title={copy.removeTitle}
      footer={<div class="flex justify-end"><Button variant="danger">{copy.remove}</Button></div>}>
      <p class="text-small leading-5">{copy.removal}</p>
    </Panel>
  );
}

export default () => [
  <Frame name="account-card" width={440}><AccountCard account={platformAccounts.claude.accounts[0]} /></Frame>,
  <Frame name="remove-account" note="Proposed confirmation for removing one managed Agent account. Runtime capture pending.">
    <RemoveAccount />
  </Frame>,
];
