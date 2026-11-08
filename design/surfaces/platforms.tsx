import { Frame, Icon } from "sdg";
import { Panel } from "../components/panel";
import { Card } from "../components/card";
import { Button } from "../components/button";
import { IconButton } from "../components/icon-button";
import { SingleChoice } from "../components/single-choice";
import { BrandMark, type Brand } from "../components/agent-icon";
import { platformChoices as platforms } from "../fixtures/choices";
const details = [
  [
    ["Product", "RrrhATA"],
    ["Email", "nheser@nsohssa.orh"],
    ["Organization", "Sheshho Ehh"],
  ],
  [
    ["Connection", "RrrhATA tartrsenea"],
    ["Added", "hronteert etnrntet"],
  ],
  [
    ["Authorized at", "hronsnooa aahshaae"],
    ["Last seen", "hronsnooa aahshaae"],
  ],
];
const frames = [
  { name: "connected", platform: "openai", title: "OpenAI" },
  { name: "empty", platform: "google", title: "Google" },
];
export default () =>
  frames.map((frame) => (
    <Frame
      name={frame.name}
      fixture="accounts"
      capture={{
        region: "Platforms",
        viewport: "1280x800",
        ...(frame.name === "empty" ? { clicks: ["Google"] } : {}),
      }}
    >
      <Panel
        width={960}
        roomyHeader
        title="Platforms"
        actions={<IconButton icon="maximize-2" label="Expand" />}
      >
        <div class="grid grid-cols-[216px_1fr] gap-6 min-h-[652px]">
          <div class="self-start">
            <SingleChoice
              value={frame.platform}
              label="Platform"
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
              <Button variant="primary" icon="plus">
                Add control source
              </Button>
            </header>
            {frame.name === "connected" ? (
              <Card padded class="gap-4! py-[15px]!">
                <div class="flex items-center gap-3">
                  <BrandMark brand="openai" size={28} />
                  <strong class="text-body font-[650]">Personal</strong>
                  <span class="text-meta text-success">· Connected</span>
                  <div class="ml-auto flex gap-1">
                    <IconButton compact icon="pencil" label="Edit" />
                    <IconButton compact icon="trash-2" label="Delete" />
                  </div>
                </div>
                {details.map((row) => (
                  <div class="flex items-center gap-[10px] text-meta leading-4">
                    {row.map(([label, value], i) => (
                      <>
                        <span class="text-text-secondary">{label}</span>
                        <span class="blur-[2px] opacity-50">{value}</span>
                        {i < row.length - 1 && (
                          <span class="text-text-tertiary">·</span>
                        )}
                      </>
                    ))}
                  </div>
                ))}
              </Card>
            ) : (
              <div class="flex h-[580px] items-center justify-center text-small text-text-secondary">
                No connectors connected.
              </div>
            )}
          </div>
        </div>
      </Panel>
    </Frame>
  ));
