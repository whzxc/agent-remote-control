import { Frame } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { Button } from "../components/button";
import { Field, Input } from "../components/field";
import clawd from "../art/pet-clawd.svg?url";
import codex from "../art/pet-codex.svg?url";
import synthetic1 from "../art/pet-synthetic1.svg?url";
import synthetic2 from "../art/pet-synthetic2.svg?url";
import synthetic3 from "../art/pet-synthetic3.svg?url";
const sites = ["codex-pets.net", "codexpet.top", "openpets.dev"];
const pets = [
  { name: "Clawd", detail: "Built in", image: clawd },
  { name: "Codex", detail: "Built in", image: codex },
  {
    name: "Synthetic 1",
    detail: "Animated geometric companion",
    image: synthetic1,
    removable: true,
  },
  {
    name: "Synthetic 2",
    detail: "Animated geometric companion",
    image: synthetic2,
    removable: true,
  },
  { name: "Synthetic 3", detail: "Codex pets · read only", image: synthetic3 },
];
export default () => (
  <Frame
    name="library"
    fixture="pets-settings"
    capture={{ region: "Pets", viewport: "1280x800" }}
    note="Pet atlas labels are decorative image content inside aria-hidden previews."
  >
    <Panel
      width={960}
      title="Pets"
      actions={<IconButton icon="maximize-2" label="Expand" />}
    >
      <div class="flex flex-col gap-[30px] pt-2">
        <Card padded class="gap-[14px]!">
          <div class="flex gap-8 text-small leading-5 font-semibold text-accent-text pb-[10px]">
            {sites.map((site) => (
              <span>{site}</span>
            ))}
          </div>
          <Field label="Pet page link">
            <Input value="https://codex-pets.net/#/pets/…" />
          </Field>
          <div class="flex gap-3">
            <Button disabled class="w-[84px] opacity-45">
              Install
            </Button>
            <Button class="w-[142px]">Choose ZIP</Button>
          </div>
        </Card>
        <section class="flex flex-col gap-[14px]">
          <h3 class="text-small leading-4 font-[650] text-text-secondary">
            Installed
          </h3>
          <div class="grid grid-cols-2 gap-x-4 gap-y-3">
            {pets.map((pet) => (
              <Card class="pt-3! pb-[14px]! px-4!">
                <div class="flex items-start gap-4">
                  <img
                    aria-hidden="true"
                    src={pet.image}
                    width={72}
                    height={72}
                  />
                  <div class="flex flex-col gap-[6px]">
                    <h4 class="text-body leading-4 font-[650] pt-1">
                      {pet.name}
                    </h4>
                    <p class="text-meta leading-4 text-text-secondary">
                      {pet.detail}
                    </p>
                    <div class="flex gap-2 pt-1">
                      <Button>Set as default</Button>
                      {pet.removable && (
                        <Button
                          variant="ghost"
                          class="bg-danger/14 text-danger!"
                        >
                          Remove
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        </section>
        <p class="text-meta leading-4 text-text-secondary pt-[2px]">
          Asset rights belong to their original authors. For personal,
          non-commercial use.
        </p>
      </div>
    </Panel>
  </Frame>
);
