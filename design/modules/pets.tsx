import { copy } from '../fixtures/pets';
import { Frame } from "adg";

import { Card } from "../components/card";

import { Button } from "../components/button";
import { Field, Input } from "../components/field";





import { sites, pets } from '../fixtures/pets';
export function PetImport() {
  return (<Card padded class="gap-[14px]!">
          <div class="flex gap-8 text-small leading-5 font-semibold text-accent-text pb-[10px]">
            {sites.map((site) => (
              <span>{site}</span>
            ))}
          </div>
          <Field label={copy.text1}>
            <Input value={copy.text2} />
          </Field>
          <div class="flex gap-3">
            <Button disabled class="w-[84px] opacity-45">{copy.text3}</Button>
            <Button class="w-[142px]">{copy.text4}</Button>
          </div>
        </Card>);
}

export function PetCard({ pet }: { pet: typeof pets[number] }) {
  return (<Card class="pt-3! pb-[14px]! px-4!">
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
                      <Button>{copy.text5}</Button>
                      {pet.removable && (
                        <Button
                          variant="ghost"
                          class="bg-danger/14 text-danger!"
                        >{copy.text6}</Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>);
}

export function PetsLibrary() {
  return (<div class="flex flex-col gap-[30px] pt-2">
        <PetImport  />
        <section class="flex flex-col gap-[14px]">
          <h3 class="text-small leading-4 font-[650] text-text-secondary">{copy.text7}</h3>
          <div class="grid grid-cols-2 gap-x-4 gap-y-3">
            {pets.map((pet) => (
              <PetCard pet={pet} />
            ))}
          </div>
        </section>
        <p class="text-meta leading-4 text-text-secondary pt-[2px]">{copy.text8}</p>
      </div>);
}

export default () => [
  <Frame name="pet-import" width={912}>
    <div class="w-full bg-surface-raised"><PetImport  /></div>
  </Frame>,
  <Frame name="pet-card-built-in" width={448}>
    <div class="w-full bg-surface-raised"><PetCard pet={pets[0]} /></div>
  </Frame>,
  <Frame name="pet-card-removable" width={448}>
    <div class="w-full bg-surface-raised"><PetCard pet={pets[2]} /></div>
  </Frame>,
  <Frame name="pets-library" width={912}>
    <div class="w-full bg-surface-raised"><PetsLibrary  /></div>
  </Frame>,
];
