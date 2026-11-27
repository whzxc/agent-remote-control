import { Frame } from "adg";
import { Monitor, Smartphone } from "lucide-react";
import {
  WelcomeChoiceCard,
  WelcomeStatusBar,
  WelcomeView,
} from "@/components/connectivity/WelcomeView";
import { LocaleProvider } from "@/i18n/react";
import ArcMark from "../art/setup-arc.svg";
import { welcomeCopy, welcomeOptions } from "../fixtures/welcome";

export function WelcomeChoice({
  option,
}: {
  option: (typeof welcomeOptions)[number];
}) {
  return (
    <WelcomeChoiceCard
      icon={option.icon === "monitor" ? Monitor : Smartphone}
      tone={option.icon === "monitor" ? "command" : "accent"}
      title={option.title}
      description={option.description}
      meta={option.meta}
    />
  );
}

export function WelcomeStatus() {
  return (
    <WelcomeStatusBar
      ready
      statusContent={welcomeCopy.status}
      inviteLabel={welcomeCopy.invite}
    />
  );
}

export function Welcome() {
  return (
    <LocaleProvider locale="zh-CN">
      <section className="welcome-page flex w-[680px] flex-col rounded-panel border border-border bg-surface-raised px-6 py-7 text-foreground shadow-lg">
        <WelcomeView
          mark={<ArcMark data-brand width={64} height={64} />}
          title={welcomeCopy.title}
          choices={welcomeOptions.map((option) => ({
            id: option.icon,
            icon: option.icon === "monitor" ? Monitor : Smartphone,
            tone: option.icon === "monitor" ? "command" : "accent",
            title: option.title,
            description: option.description,
            meta: option.meta,
          }))}
          status={{
            ready: true,
            statusContent: welcomeCopy.status,
            inviteLabel: welcomeCopy.invite,
          }}
        />
      </section>
    </LocaleProvider>
  );
}

export default () => [
  ...welcomeOptions.map((option, i) => (
    <Frame
      key={option.icon}
      name={i === 0 ? "welcome-choice-local" : "welcome-choice-remote"}
      width={308}
      height={178}
    >
      <div className="grid h-full w-full bg-surface-raised">
        <WelcomeChoice option={option} />
      </div>
    </Frame>
  )),
  <Frame key="welcome-status" name="welcome-status" width={632}>
    <div className="w-full bg-surface-raised">
      <WelcomeStatus />
    </div>
  </Frame>,
];
