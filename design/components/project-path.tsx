import { Frame } from "adg";

export function ProjectLabel({ name, path, label = "Project" }: { name: string; path?: string; label?: string }) {
  return <span class="inline-flex h-5 max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-(--radius-pill) bg-surface-sunken px-[6px] text-caption text-text-secondary"
    title={[label, name, path].filter(Boolean).join(" · ")}>
    <span class="shrink-0">{label}</span><strong class="truncate font-semibold text-text">{name}</strong>
  </span>;
}

export function FilePath({ directory, filename, fullPath, full = false }: { directory: string; filename: string; fullPath: string; full?: boolean }) {
  return <span title={fullPath} class={`max-w-full min-w-0 font-mono ${full ? "break-all" : "flex whitespace-nowrap"}`}>
    {full ? fullPath : <><span class="truncate text-text-tertiary">{directory}</span>
      <span class="max-w-full min-w-0 shrink-0 truncate">{filename}</span></>}
  </span>;
}

export default () => [
  <Frame name="project"><ProjectLabel name="Acceptance" path="/workspace/acceptance" /></Frame>,
  <Frame name="project-compact" width={88} locale="zh-CN">
    <ProjectLabel label="项目" name="Acceptance workspace" path={"C:\\Work\\acceptance"} />
  </Frame>,
  <Frame name="file-relative" width={200}>
    <FilePath directory="packages/connector/src/" filename="session.ts" fullPath="/workspace/acceptance/packages/connector/src/session.ts" />
  </Frame>,
  <Frame name="file-full" width={200}>
    <FilePath full directory="packages/connector/src/" filename="session.ts" fullPath="/workspace/acceptance/packages/connector/src/session.ts" />
  </Frame>,
];
