import { EntityCard } from '../components/entity-inventory';
import { Frame } from "adg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { Field, Input } from "../components/field";
import { IconButton } from "../components/icon-button";
import { Dialog } from "../components/panel";
import { Tag } from "../components/tag";
import { platformAccountCopy as copy, platformAccounts } from "../fixtures/agent-accounts";
import { QuotaCards, type QuotaWindow } from '../components/quota';

export type AgentAccount = { alias: string; email?: string; default?: boolean; removable?: boolean } & (
  | { state: "signed-in"; windows: readonly QuotaWindow[] }
  | { state: "signed-out" }
);

export function AccountCard({ account }: { account: AgentAccount }) {
  const signedIn = account.state === "signed-in";
  const status = signedIn ? copy.quotaUnavailable : copy.signedOut;
  return (
    <EntityCard padded variant="reply" className="gap-3! border border-border">
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2">
            <h3 className="flex min-w-0"><Button variant="link" className="max-w-full">
              <span className="truncate">{account.alias}</span>
            </Button></h3>
            {account.default && <Tag form="meta">{copy.default}</Tag>}
          </div>
          {account.email && <p className="truncate text-meta leading-4 text-text-secondary">{account.email}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <IconButton compact icon="pencil" label={copy.edit} />
          {signedIn && <IconButton compact icon="refresh-cw" label={copy.refresh} />}
          {account.removable !== false && <IconButton compact icon="trash-2" label={copy.remove} />}
        </div>
      </div>
      {signedIn && account.windows.length ? (
        <QuotaCards windows={account.windows} />
      ) : (
        <div className="flex min-h-(--control-height) items-center justify-between gap-2">
          <p className={`text-meta ${signedIn ? "text-text-secondary" : "text-danger"}`}>{status}</p>
          {!signedIn && <Button>{copy.reauth}</Button>}
        </div>
      )}
    </EntityCard>
  );
}

export function EditAccountAlias({ account }: { account: AgentAccount }) {
  return (
    <Dialog title={copy.edit}
      footer={<div className="flex justify-end"><Button variant="primary">{copy.save}</Button></div>}>
      <Field label={copy.alias}><Input value={account.alias} /></Field>
    </Dialog>
  );
}

export function RemoveAccount() {
  return (
    <Dialog title={copy.removeTitle}
      footer={<div className="flex justify-end"><Button variant="danger">{copy.remove}</Button></div>}>
      <p className="text-small leading-5">{copy.removal}</p>
    </Dialog>
  );
}

export default () => [
  <Frame name="account-card" width={440}><AccountCard account={platformAccounts.claude.accounts[0]} /></Frame>,
  <Frame name="edit-account-alias" width={592} fixture="agent-account-edit"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
    <EditAccountAlias account={platformAccounts.claude.accounts[0]} />
  </Frame>,
  <Frame name="remove-account" width={592} fixture="agent-account-remove"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}>
    <RemoveAccount />
  </Frame>,
];
