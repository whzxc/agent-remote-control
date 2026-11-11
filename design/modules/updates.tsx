import { Frame, Icon } from "sdg";
import { Button } from "../components/button";
import { Card } from "../components/card";
import { IconButton } from "../components/icon-button";
import { Notice } from "../components/notice";
import { SettingLine, SettingsGroup } from "../components/settings-row";
import { copy, download, frames, releases } from "../fixtures/updates";

type UpdateState = (typeof frames)[number]["name"];
type Release = (typeof releases)[number];

const preview = ["改进", "修复"].map(title => ({
  title,
  items: releases.flatMap(({ version, sections }) =>
    sections.filter(section => section.title === title)
      .flatMap(section => section.items.map(text => ({ version, text }))),
  ),
}));

function NoteGroup({ title, items }: {
  title: string;
  items: ReadonlyArray<{ text: string; version?: string }>;
}) {
  return (
    <section class="flex flex-col gap-2">
      <h3 class="text-small leading-4 font-semibold">{title}</h3>
      <ul class="flex list-disc flex-col gap-1.5 pl-5 text-body leading-5 text-text-secondary">
        {items.map(({ text, version }) => (
          <li>
            {text}
            {version && <span class="ml-2 whitespace-nowrap text-meta text-text-tertiary">{version}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function UpdateContent({ state }: { state: UpdateState }) {
  const ready = state === "available";
  const downloading = state === "downloading";
  const failed = state === "download-failed";
  const installing = state === "installing";
  const status = ready ? copy.ready : downloading ? copy.downloading : "";
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3 text-meta leading-4 text-text-secondary" role="status">
          <p>{[copy.fromVersion, status].filter(Boolean).join(" · ")}</p>
          {downloading && <span>{download.amount}</span>}
        </div>
        {downloading && (
          <div role="progressbar" aria-label={copy.downloading} aria-valuenow={download.percent}
            class="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div class="h-full rounded-full bg-accent" style={{ width: `${download.percent}%` }} />
          </div>
        )}
      </div>
      {failed && <Notice>{copy.downloadFailed}</Notice>}
      <Card padded class="max-h-[280px] gap-4 overflow-y-auto">
        {preview.map(section => <NoteGroup {...section} />)}
      </Card>
      <div class="flex flex-col gap-3">
        {(ready || installing) && <p class="text-meta leading-4 text-text-secondary">{copy.restartEffect}</p>}
        <div class="flex min-h-(--control-height) items-center justify-between gap-3">
          <Button variant="ghost" disabled={installing} class={installing ? "opacity-45" : ""}>{copy.later}</Button>
          {failed && <Button variant="primary" icon="refresh-cw">{copy.retry}</Button>}
          {(ready || installing) && (
            <Button variant="primary" busy={installing} icon="rotate-cw">
              {installing ? copy.installing : copy.restart}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function UpdateHistoryContent({ entries }: { entries: readonly Release[] }) {
  return (
    <div class="flex min-w-0 flex-col gap-4">
      <div class="flex max-h-[360px] flex-col gap-3 overflow-y-auto">
        {entries.map(release => (
          <Card padded>
            <h2 class="text-body leading-5 font-semibold">{release.version}</h2>
            {release.sections.map(({ title, items }) => (
              <NoteGroup title={title} items={items.map(text => ({ text }))} />
            ))}
          </Card>
        ))}
      </div>
      <div class="flex justify-end">
        <Button variant="link">{copy.allReleases}<Icon name="arrow-up-right" size={14} /></Button>
      </div>
    </div>
  );
}

export function UpdateAboutContent() {
  return (
    <div class="flex flex-col gap-3">
      <SettingsGroup title={copy.about}>
        <SettingLine title={copy.appVersion}>
          <Button>{copy.check}</Button>
        </SettingLine>
        <SettingLine title={copy.history} class="border-t border-border">
          <IconButton icon="chevron-right" label={copy.history} />
        </SettingLine>
      </SettingsGroup>
      <nav class="flex flex-wrap items-center gap-2 px-4" aria-label={copy.about}>
        <span class="text-meta text-text-secondary">{copy.repository}</span>
        <Button variant="ghost">GitHub<Icon name="external-link" size={14} /></Button>
        <div class="ml-auto">
          <Button variant="ghost">{copy.experimental}<Icon name="chevron-right" size={14} /></Button>
        </div>
      </nav>
    </div>
  );
}

export default () => [
  ...frames.map(({ name }) => (
    <Frame name={`update-content-${name}`} width={472}>
      <div class="w-full bg-surface-raised"><UpdateContent state={name} /></div>
    </Frame>
  )),
  <Frame name="update-history-content" width={472}>
    <div class="w-full bg-surface-raised"><UpdateHistoryContent entries={releases} /></div>
  </Frame>,
  <Frame name="update-about-content" width={672}>
    <div class="w-full bg-surface-raised"><UpdateAboutContent /></div>
  </Frame>,
];
