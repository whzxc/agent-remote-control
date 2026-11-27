import { Frame } from "adg";
import { Button } from "../components/button";
import { Tile } from "../components/tile";
import ArcMark from "../art/setup-arc.svg";
import { welcomeOptions, welcomeCopy } from "../fixtures/welcome";

export function WelcomeChoice({ option }: { option: typeof welcomeOptions[number] }) {
  return (
    <div className="flex flex-col rounded-card bg-surface-subtle p-5">
      <Tile
        icon={option.icon}
        tone={option.icon === "monitor" ? "command" : "accent"}
      />
      <h3 className="mt-[17px] text-body leading-4 font-[650]">
        {option.title}
      </h3>
      <p className="mt-3 text-small leading-4 text-text-secondary">
        {option.description}
      </p>
      <p className="mt-[21px] text-meta leading-4 text-text-secondary">
        {option.meta}
      </p>
    </div>
  );
}
export function WelcomeStatus() {
  return (
    <div className="flex items-center justify-between px-[22px]">
      <span className="flex items-center gap-3 text-small font-semibold">
        <span className="size-[6px] rounded-full bg-success" />{welcomeCopy.status}</span>
      <Button variant="ghost" className="w-[222px]">{welcomeCopy.invite}</Button>
    </div>
  );
}
export function Welcome() {
  return (
    <section className="flex w-[680px] flex-col rounded-panel bg-surface-raised px-6 pt-[13px] pb-6 text-text shadow-lg">
      <div className="flex flex-col pt-[15px]">
        <div className="flex flex-col items-center gap-[21px]">
          <ArcMark data-brand width={64} height={64} />
          <h2 className="text-title leading-6 font-[650]">{welcomeCopy.title}</h2>
        </div>
        <div className="mt-[39px] grid grid-cols-2 gap-4">
          {welcomeOptions.map((option) => (
            <WelcomeChoice option={option} />
          ))}
        </div>
        <div className="mt-9"><WelcomeStatus /></div>
      </div>
    </section>
  );
}
export default () => [
  ...welcomeOptions.map((option, i) => (
    <Frame name={i === 0 ? "welcome-choice-local" : "welcome-choice-remote"} width={308} height={178}>
      <div className="grid h-full w-full bg-surface-raised"><WelcomeChoice option={option} /></div>
    </Frame>
  )),
  <Frame name="welcome-status" width={632}>
    <div className="w-full bg-surface-raised"><WelcomeStatus /></div>
  </Frame>,
];
