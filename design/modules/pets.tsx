import type { ReactNode } from "react";
import {InspectionPopover} from '../components/inspection-popover';
import {SingleChoice} from '../components/single-choice';
export function LibraryContent({children,className:extra=''}:{children:ReactNode;className?:string}){return <div className={extra}>{children}</div>}
import { copy } from '../fixtures/pets';
import { Frame } from "adg";

import { Card } from "../components/card";

import { Button } from "../components/button";
import { Field, Input } from "../components/field";





import { sites, pets } from '../fixtures/pets';
export function PetImport() {
  return (<Card padded className="gap-[14px]!">
          <div className="flex gap-8 text-small leading-5 font-semibold text-accent-text pb-[10px]">
            {sites.map((site) => (
              <span>{site}</span>
            ))}
          </div>
          <Field label={copy.text1}>
            <Input value={copy.text2} />
          </Field>
          <div className="flex gap-3">
            <Button disabled className="w-[84px] opacity-45">{copy.text3}</Button>
            <Button className="w-[142px]">{copy.text4}</Button>
          </div>
        </Card>);
}

export function PetCard({ pet }: { pet: typeof pets[number] }) {
  return (<Card className="pt-3! pb-[14px]! px-4!">
                <div className="flex items-start gap-4">
                  <img
                    aria-hidden="true"
                    src={pet.image}
                    width={72}
                    height={72}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-[6px]">
                    <h4 className="text-body leading-4 font-[650] pt-1">
                      {pet.name}
                    </h4>
                    <p className="text-meta leading-4 text-text-secondary">
                      {pet.detail}
                    </p>
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button>{copy.text5}</Button>
                      {pet.removable && (
                        <Button
                          variant="ghost"
                          className="bg-danger/14 text-danger!"
                        >{copy.text6}</Button>
                      )}
                    </div>
                  </div>
                </div>
              </Card>);
}

export function PetsLibrary() {
  return (<LibraryContent className="flex flex-col gap-[30px] pt-2">
        <PetImport  />
        <section className="flex flex-col gap-[14px]">
          <h3 className="text-small leading-4 font-[650] text-text-secondary">{copy.text7}</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3">
            {pets.map((pet) => (
              <PetCard pet={pet} />
            ))}
          </div>
        </section>
        <p className="text-meta leading-4 text-text-secondary pt-[2px]">{copy.text8}</p>
      </LibraryContent>);
}

export default () => [
  <Frame name="pet-chooser" width={360}><PetChooser/></Frame>,
  <Frame name="pet-import" width={912}>
    <div className="w-full bg-surface-raised"><PetImport  /></div>
  </Frame>,
  <Frame name="pet-card-built-in" width={448}>
    <div className="w-full bg-surface-raised"><PetCard pet={pets[0]} /></div>
  </Frame>,
  <Frame name="pet-card-removable" width={448}>
    <div className="w-full bg-surface-raised"><PetCard pet={pets[2]} /></div>
  </Frame>,
  <Frame name="pets-library" width={912}>
    <div className="w-full bg-surface-raised"><PetsLibrary  /></div>
  </Frame>,
];

function PetChooser() {return <InspectionPopover variant="pet" className="w-[360px] rounded-card border border-border bg-surface text-text shadow-md p-3"><SingleChoice tiles iconOnly label="Choose pet" value="inherit" options={[{value:'inherit',label:'Inherit',icon:'paw-print'},...pets.map((pet,i)=>({value:String(i),label:pet.name,graphic:<img src={pet.image} width={72} height={72}/>}))]}/></InspectionPopover>;}
