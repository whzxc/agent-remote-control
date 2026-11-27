import {Tooltip} from './tooltip';
import { Frame } from "adg";

export function ProjectLabel({ name, path, label = "Project" }: { name: string; path?: string; label?: string }) {
  return <Tooltip text={[label,name,path].filter(Boolean).join(" · ")}><span className="inline-flex h-6 max-w-full min-w-0 items-center gap-1 overflow-hidden rounded-(--radius-pill) bg-surface-sunken px-[9px] text-meta text-text-secondary"
    title={[label, name, path].filter(Boolean).join(" · ")}>
    <strong className="truncate font-semibold text-text">{name}</strong>
  </span></Tooltip>;
}

export function FilePath({ directory, filename, fullPath, full = false }: { directory: string; filename: string; fullPath: string; full?: boolean }) {
  return <span title={fullPath} className={`max-w-full min-w-0 font-mono ${full ? "break-all" : "flex whitespace-nowrap"}`}>
    {full ? fullPath : <><span className="truncate text-text-tertiary">{directory}</span>
      <span className="max-w-full min-w-0 shrink-0 truncate">{filename}</span></>}
  </span>;
}

export default () => [
  <Frame name="project"><ProjectLabel name="Acceptance" path="/workspace/acceptance" /></Frame>,
  <Frame name="file-relative" width={200}>
    <FilePath directory="packages/connector/src/" filename="session.ts" fullPath="/workspace/acceptance/packages/connector/src/session.ts" />
  </Frame>,
  <Frame name="file-full" width={200}>
    <FilePath full directory="packages/connector/src/" filename="session.ts" fullPath="/workspace/acceptance/packages/connector/src/session.ts" />
  </Frame>,
];
