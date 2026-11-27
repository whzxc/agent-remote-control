import { Frame } from "adg";
import { LocaleProvider } from "@/i18n/react";
import {
  AccountCardView,
  EditAccountAliasSurface,
  RemoveAccountSurface,
} from "@/components/AccountCardView";
import {
  platformAccountCopy as copy,
  platformAccounts,
} from "../fixtures/agent-accounts";
import { QuotaCards, type QuotaWindow } from "../components/quota";

export type AgentAccount = {
  alias: string;
  email?: string;
  default?: boolean;
  removable?: boolean;
} & (
  | { state: "signed-in"; windows: readonly QuotaWindow[] }
  | { state: "signed-out" }
);

export function AccountCard({ account }: { account: AgentAccount }) {
  const signedIn = account.state === "signed-in";
  return (
    <LocaleProvider locale="zh-CN">
      <AccountCardView
        alias={account.alias}
        emailNode={account.email}
        isDefault={account.default}
        defaultLabel={copy.default}
        signedIn={signedIn}
        canRemove={account.removable !== false}
        editLabel={copy.edit}
        refreshLabel={copy.refresh}
        removeLabel={copy.remove}
        statusLabel={signedIn ? copy.quotaUnavailable : copy.signedOut}
        reauthLabel={!signedIn ? copy.reauth : undefined}
        quotaSlot={
          signedIn && account.windows.length ? (
            <QuotaCards windows={account.windows} />
          ) : undefined
        }
      />
    </LocaleProvider>
  );
}

export function EditAccountAlias({ account }: { account: AgentAccount }) {
  return (
    <LocaleProvider locale="zh-CN">
      <EditAccountAliasSurface
        title={copy.edit}
        aliasLabel={copy.alias}
        alias={account.alias}
        saveLabel={copy.save}
        closeLabel={copy.close}
      />
    </LocaleProvider>
  );
}

export function RemoveAccount() {
  return (
    <LocaleProvider locale="zh-CN">
      <RemoveAccountSurface
        title={copy.removeTitle}
        consequence={copy.removal}
        removeLabel={copy.remove}
        closeLabel={copy.close}
      />
    </LocaleProvider>
  );
}

export default () => [
  <Frame key="account-card" name="account-card" width={440}>
    <AccountCard account={platformAccounts.claude.accounts[0]} />
  </Frame>,
  <Frame
    key="edit-account-alias"
    name="edit-account-alias"
    width={592}
    fixture="agent-account-edit"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}
  >
    <EditAccountAlias account={platformAccounts.claude.accounts[0]} />
  </Frame>,
  <Frame
    key="remove-account"
    name="remove-account"
    width={592}
    fixture="agent-account-remove"
    capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}
  >
    <RemoveAccount />
  </Frame>,
];
