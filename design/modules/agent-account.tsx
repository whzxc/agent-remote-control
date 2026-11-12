import { Frame } from "adg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Field, Input } from "../components/field";
import { IconButton } from "../components/icon-button";
import { Dialog } from "../components/panel";
import { Tag } from "../components/tag";
import { platformAccountCopy as copy, platformAccounts } from "../fixtures/agent-accounts";
import { QuotaCards, type QuotaWindow } from "./quota";

export type AgentAccount = { alias: string; email?: string; default?: boolean; removable?: boolean } & (
  | { state: "signed-in"; windows: readonly QuotaWindow[] }
  | { state: "signed-out" }
);

export function AccountCard({ account }: { account: AgentAccount }) {
  const signedIn = account.state === "signed-in";
  const status = signedIn ? copy.quotaUnavailable : copy.signedOut;
  return (
    <Card padded variant="reply" class="gap-3! border border-border">
      <div class="flex items-center gap-2">
        <div class="flex min-w-0 flex-1 flex-col">
          <div class="flex items-center gap-2">
            <h3 class="min-w-0"><Button variant="link" class="max-w-full">
              <span class="truncate">{account.alias}</span>
            </Button></h3>
            {account.default && <Tag form="meta">{copy.default}</Tag>}
          </div>
          {account.email && <p class="truncate text-meta leading-4 text-text-secondary">{account.email}</p>}
        </div>
        <div class="flex shrink-0 items-center gap-1">
          <IconButton compact icon="pencil" label={copy.edit} />
          {signedIn && <IconButton compact icon="refresh-cw" label={copy.refresh} />}
          {account.removable !== false && <IconButton compact icon="trash-2" label={copy.remove} />}
        </div>
      </div>
      {signedIn && account.windows.length ? <QuotaCards windows={account.windows} /> : (
        <div class="flex min-h-(--control-height) items-center justify-between gap-2">
          <p class={`text-meta ${signedIn ? "text-text-secondary" : "text-danger"}`}>{status}</p>
          {!signedIn && <Button>{copy.reauth}</Button>}
        </div>
      )}
    </Card>
  );
}

export function EditAccountAlias({ account }: { account: AgentAccount }) {
  return (
    <Dialog size="s" title={copy.edit}
      footer={<div class="flex justify-end"><Button variant="primary">{copy.save}</Button></div>}>
      <Field label={copy.alias}><Input value={account.alias} /></Field>
    </Dialog>
  );
}

export function RemoveAccount() {
  return (
    <Dialog size="s" title={copy.removeTitle}
      footer={<div class="flex justify-end"><Button variant="danger">{copy.remove}</Button></div>}>
      <p class="text-small leading-5">{copy.removal}</p>
    </Dialog>
  );
}

export default () => [
  <Frame name="account-card" width={440}><AccountCard account={platformAccounts.claude.accounts[0]} /></Frame>,
  <Frame name="edit-account-alias" fixture="agent-account-edit"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
    <EditAccountAlias account={platformAccounts.claude.accounts[0]} />
  </Frame>,
  <Frame name="remove-account" fixture="agent-account-remove"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
    <RemoveAccount />
  </Frame>,
];
