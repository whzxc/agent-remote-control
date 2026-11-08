import { copy } from '../fixtures/connectors';
import { Frame, Icon } from "sdg";

import { Card } from "../components/card";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { SingleChoice } from "../components/single-choice";
import { BrandMark, type Brand } from "../components/agent-icon";
import { platformChoices as platforms } from "../fixtures/choices";
import { details, frames } from '../fixtures/connectors';
export function ConnectorCard() {
  return (<Card padded class="gap-4! py-[15px]!">
                <div class="flex items-center gap-3">
                  <BrandMark brand="openai" size={28} />
                  <strong class="text-body font-[650]">{copy.text1}</strong>
                  <span class="text-meta text-success">{copy.text2}</span>
                  <div class="ml-auto flex gap-1">
                    <IconButton compact icon="pencil" label={copy.text3} />
                    <IconButton compact icon="trash-2" label={copy.text4} />
                  </div>
                </div>
                {details.map((row) => (
                  <div class="flex items-center gap-[10px] text-meta leading-4">
                    {row.map(([label, value], i) => (
                      <>
                        <span class="text-text-secondary">{label}</span>
                        <span class="blur-[2px] opacity-50">{value}</span>
                        {i < row.length - 1 && (
                          <span class="text-text-tertiary">{copy.text5}</span>
                        )}
                      </>
                    ))}
                  </div>
                ))}
              </Card>);
}

export function ConnectorContent({ frame }: { frame: typeof frames[number] }) {
  return (<div class="grid grid-cols-[216px_1fr] gap-6 min-h-[652px]">
          <div class="self-start">
            <SingleChoice
              value={frame.platform}
              label={copy.text6}
              navigation
              options={platforms.map(([value, label]) => ({
                value,
                label,
                graphic:
                  value === "other" ? (
                    <Icon name="plug" size={22} />
                  ) : (
                    <BrandMark brand={value as Brand} size={22} />
                  ),
              }))}
            />
          </div>
          <div class="flex flex-col gap-[22px]">
            <header class="flex items-center justify-between">
              <h3 class="text-title leading-6 font-[650]">{frame.title}</h3>
              <Button variant="primary" icon="plus">{copy.text7}</Button>
            </header>
            {frame.name === "connected" ? (
              <ConnectorCard  />
            ) : (
              <div class="flex h-[580px] items-center justify-center text-small text-text-secondary">{copy.text8}</div>
            )}
          </div>
        </div>);
}

export default () => [
  <Frame name="connector-card" width={672}><div class="w-full bg-surface-raised"><ConnectorCard  /></div></Frame>,
  <Frame name="connector-content-connected" width={912}><div class="w-full bg-surface-raised"><ConnectorContent frame={frames[0]} /></div></Frame>,
  <Frame name="connector-content-empty" width={912}><div class="w-full bg-surface-raised"><ConnectorContent frame={frames[1]} /></div></Frame>,
];
