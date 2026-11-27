import type { ReactNode } from "react";
import { Frame } from "adg";
import { LocaleProvider } from "@/i18n/react";
import { AgentAccountDialogView } from "@/components/AgentAccountDialogView";
import { accountSignIn as signIn } from "../fixtures/agent-accounts";

export function SetupAccountDialog({ children }: { children: ReactNode }) {
  return <div className="text-small leading-5">{children}</div>;
}

type Flow = "claude-add" | "reauth" | "waiting" | "expired";

export function AgentAccountAdd({ flow = "claude-add" }: { flow?: Flow }) {
  const title = flow === "claude-add" ? signIn.add : signIn.reauth;
  const waiting = flow === "waiting";
  const expired = flow === "expired";

  return (
    <LocaleProvider locale="zh-CN">
      <AgentAccountDialogView
        title={title}
        active={waiting}
        expired={expired}
        codeEntry={waiting}
        notice={expired ? signIn.failure : undefined}
        waitingStatus={`${signIn.waiting} · ${signIn.browsers[1].label}`}
        codeLabel={signIn.code}
        codePlaceholder={signIn.codePlaceholder}
        browserLabel={signIn.browser}
        browserValue="chrome-profile"
        browserOptions={signIn.browsers}
        copyLinkLabel={signIn.copyLink}
        submitCodeLabel={signIn.submit}
        primaryLabel={expired ? signIn.retry : signIn.start}
      />
    </LocaleProvider>
  );
}

export default () =>
  (
    [
      ["claude-add", "claude-add"],
      ["reauth-waiting", "waiting"],
      ["reauth-expired", "expired"],
    ] as const
  ).map(([name, flow]) => (
    <Frame
      key={name}
      name={name}
      width={592}
      fixture={`agent-account-${name}`}
      capture={{ selector: ".dialog.agent-account-add", viewport: "1280x800" }}
    >
      <AgentAccountAdd flow={flow} />
    </Frame>
  ));
