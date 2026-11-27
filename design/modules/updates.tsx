import { Frame } from "adg";
import type { ReactNode } from "react";
import { UpdateHistoryView } from "@/components/updates/UpdateHistoryView";
import {
  UpdatePanelView,
  type ReleaseNoteGroup,
} from "@/components/updates/UpdatePanelView";
import { LocaleProvider } from "@/i18n/react";
import {
  copy,
  download,
  frames,
  installedVersion,
  releases,
  targetVersion,
} from "../fixtures/updates";

export function ReleaseContent({
  children,
  className: extra = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={extra}>{children}</div>;
}

type UpdateState = (typeof frames)[number]["name"];
type Release = (typeof releases)[number];

const previewGroups: ReleaseNoteGroup[] = ["改进", "修复"].map((title) => ({
  title,
  bullets: releases.flatMap(({ version, sections }) =>
    sections
      .filter((section) => section.title === title)
      .flatMap((section) =>
        section.items.map((text) => ({ version, text })),
      ),
  ),
}));

export function UpdateContent({ state }: { state: UpdateState }) {
  const ready = state === "available";
  const downloading = state === "downloading";
  const failed = state === "download-failed";
  const installing = state === "installing";

  return (
    <ReleaseContent className="flex min-w-0 flex-col">
      <LocaleProvider locale="zh-CN">
        <UpdatePanelView
          showHeader={false}
          targetVersion={targetVersion}
          currentVersion={installedVersion}
          phase={
            downloading
              ? "downloading"
              : installing
                ? "installing"
                : "idle"
          }
          ready={ready || installing}
          available={ready || failed || installing}
          downloadedAmount={downloading ? download.amount : undefined}
          progressPercent={downloading ? download.percent : undefined}
          error={failed ? copy.downloadFailed : undefined}
          noteGroups={previewGroups}
          showNoteVersions
        />
      </LocaleProvider>
    </ReleaseContent>
  );
}

export function UpdateHistoryContent({
  entries,
}: {
  entries: readonly Release[];
}) {
  return (
    <LocaleProvider locale="zh-CN">
      <UpdateHistoryView
        releases={entries.map((release) => ({
          version: release.version,
          groups: release.sections.map((section) => ({
            title: section.title,
            bullets: section.items.map((text) => ({ text })),
          })),
        }))}
      />
    </LocaleProvider>
  );
}

export default () => [
  ...frames.map(({ name }) => (
    <Frame key={name} name={`update-content-${name}`} width={472}>
      <div className="w-full bg-surface-raised">
        <UpdateContent state={name} />
      </div>
    </Frame>
  )),
  <Frame key="update-history-content" name="update-history-content" width={472}>
    <div className="w-full bg-surface-raised">
      <UpdateHistoryContent entries={releases} />
    </div>
  </Frame>,
];
