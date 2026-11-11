import { copy } from '../fixtures/relay-hosting';
import { Frame } from "adg";


import { Button } from "../components/button";

export function RelayHostingContent() {
  return (<div class="flex flex-col items-start gap-5 pt-[6px]">
        <div class="flex flex-col gap-3">
          <h3 class="text-body leading-4 font-[650]">{copy.text1}</h3>
          <p class="text-body leading-4 text-text-secondary">{copy.text2}</p>
        </div>
        <Button class="w-[186px]">{copy.text3}</Button>
      </div>);
}

export default () => [
  <Frame name="empty" width={712}>
    <div class="w-full bg-surface-raised"><RelayHostingContent  /></div>
  </Frame>,
];
