import { copy } from '../fixtures/updates';
import { Frame, Icon } from "sdg";

import { Card } from "../components/card";
import { Button } from "../components/button";
import { changes, frames } from '../fixtures/updates';
export function UpdateContent({ name }: { name: typeof frames[number]["name"] }) {
  return (<div class="flex flex-col gap-6">
          <Card padded class="gap-2!">
            {changes.map((text) => (
              <p class="text-body leading-4">{text}</p>
            ))}
          </Card>
          <div class="flex items-center justify-between">
            <Button
              variant="ghost"
              disabled={name === "installing"}
              class={name === "installing" ? "opacity-45" : ""}
            >{copy.text1}</Button>
            <Button
              variant="primary"
              busy={name === "installing"}
              class="w-[220px]"
            >
              {name === "installing"
                ? "Installing and restarting…"
                : "Update and restart"}
            </Button>
          </div>
        </div>);
}

export function UpdateAboutContent() {
  return (<div class="flex flex-col gap-3 pt-[9px]">
        <h2 class="text-small leading-4 font-[650] text-text-secondary">{copy.text2}</h2>
        <Card padded class="gap-4!">
          <div class="flex flex-col gap-[6px]">
            <p class="text-body leading-4 font-medium">{copy.text3}</p>
            <p class="text-meta leading-4 text-text-secondary">{copy.text4}</p>
          </div>
          <div class="flex gap-4">
            <Button disabled class="opacity-45">{copy.text5}</Button>
            <Button>{copy.text6}</Button>
          </div>
        </Card>
        <div class="flex items-center gap-3 px-4 pt-[18px]">
          <span class="text-meta text-text-secondary">{copy.text7}</span>
          <Button variant="ghost">{copy.text8}<Icon name="external-link" />
          </Button>
          <Button variant="ghost">{copy.text9}<Icon name="chevron-right" />
          </Button>
        </div>
      </div>);
}

export default () => [
  <Frame name="update-content-available" width={472}>
    <div class="w-full bg-surface-raised"><UpdateContent name="available" /></div>
  </Frame>,
  <Frame name="update-content-installing" width={472}>
    <div class="w-full bg-surface-raised"><UpdateContent name="installing" /></div>
  </Frame>,
  <Frame name="update-about-content" width={672}>
    <div class="w-full bg-surface-raised"><UpdateAboutContent  /></div>
  </Frame>,
];
