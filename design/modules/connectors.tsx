import { copy } from "../fixtures/connectors";
import { Frame, Icon } from "adg";

import { Card } from "../components/card";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { SingleChoice } from "../components/single-choice";
import { BrandMark, type Brand } from "../components/agent-icon";
import { platformChoices as platforms } from "../fixtures/choices";
import { details, frames } from "../fixtures/connectors";
export function ConnectorCard({ brand = "openai", title = copy.text1, state = copy.text2, facts = details }: { brand?: Brand; title?: string; state?: string; facts?: string[][][] } = {}) {
  return (
    <Card padded class="gap-3!">
      <div class="flex items-center gap-3">
        <BrandMark brand={brand} size={28} />
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2"><strong class="text-body leading-5 font-[650]">{title}</strong><span class="text-meta leading-4 text-success">{state.split(" ").map((word, index) => <>{index > 0 && " "}<span>{word}</span></>)}</span></div>
        <div class="ml-auto flex gap-1">
          <IconButton compact icon="pencil" label={copy.text3} />
          <IconButton compact icon="trash-2" label={copy.text4} />
        </div>
      </div>
      <div class="flex flex-col gap-5">{facts.map((row) => (
        <div class="flex flex-wrap items-baseline gap-x-[10px] gap-y-2 text-meta leading-4">
          {row.map(([label, value], i) => (
            <span class="inline-flex min-w-0 max-w-full items-baseline gap-[6px]">
              {i > 0 && <span aria-hidden="true" class="mr-1 text-text-tertiary">{copy.text5}</span>}
              <span class="text-text-secondary">{label}</span>
              <span aria-hidden="true" class="blur-[2px] opacity-50">{value}</span>
            </span>
          ))}
        </div>
      ))}</div>
    </Card>
  );
}

export function ConnectorContent({ frame }: { frame: (typeof frames)[number] }) {
  return (
    <div class="grid grid-cols-[216px_minmax(0,1fr)] gap-6">
      <div class="self-start">
        <SingleChoice
          value={frame.platform}
          label={copy.text6}
          navigation
          options={platforms.map(([value, label]) => ({
            value,
            label,
            graphic:
              value === "other" ? <Icon name="plug" size={22} /> : <BrandMark brand={value as Brand} size={22} />,
          }))}
        />
      </div>
      <div class="flex min-w-0 flex-col gap-[22px]">
        <header class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="text-title leading-6 font-[650]">{frame.title}</h3>
          <Button variant="primary" icon="plus">
            {copy.text7}
          </Button>
        </header>
        {frame.name === "connected" ? (
          <ConnectorCard />
        ) : (
          <div class="flex flex-1 items-center justify-center text-small text-text-secondary">{copy.text8}</div>
        )}
      </div>
    </div>
  );
}

import { sourceConnectorCopy } from "../fixtures/connectors";

import { sourceFacts } from "../fixtures/connectors";
export function SourceConnectorSummary({ class: extra = "mt-7" }: { class?: string }) {
  return <div class={extra}><ConnectorCard brand="anthropic" title={sourceConnectorCopy.text1} state={sourceConnectorCopy.text2}
    facts={sourceFacts.map(row => row.map(fact => [fact.label, fact.value]))} /></div>;
}

export default () => [
  <Frame name="connector-card" width={672}>
    <div class="w-full bg-surface-raised">
      <ConnectorCard />
    </div>
  </Frame>,
  <Frame name="connector-content-connected" width={912}>
    <div class="w-full bg-surface-raised">
      <ConnectorContent frame={frames[0]} />
    </div>
  </Frame>,
  <Frame name="connector-content-empty" width={912}>
    <div class="w-full bg-surface-raised">
      <ConnectorContent frame={frames[1]} />
    </div>
  </Frame>,
  <Frame name="source-connector-summary" width={440}>
    <div class="w-full bg-surface-raised">
      <SourceConnectorSummary class="" />
    </div>
  </Frame>,
];
