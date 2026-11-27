import { useState } from "react";
import { ChevronRight, GitCompareArrows } from "lucide-react";
import type { AgentTimelineEntry } from "../types";
import { t } from "../i18n";
import { changedFiles } from "../state/taskProjection";
import { CollapsiblePrimitive } from "./kit/collapsible";
import { FilePath } from "./ui/ProjectPath";
import { Button, Icon } from "./ui";

export function ChangedFiles({ entries, project, cwd }: { entries: AgentTimelineEntry[]; project?: string | null; cwd?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const files = changedFiles(entries);
  if (!files.length) return null;
  const renderFile = (file: typeof files[number]) => (
    <div className="task-change-row" key={file.path}>
      <span className="task-file-chip"><FilePath path={file.path} project={project} cwd={cwd} /></span>
      {(file.operation === "create" || file.operation === "delete") && (
        <span className="task-file-operation" data-operation={file.operation}>
          {t(file.operation === "create" ? "detail.fileCreated" : "detail.fileDeleted")}
        </span>
      )}
      {file.added !== undefined && <span className="task-added">+{file.added}</span>}
      {file.removed !== undefined && <span className="task-removed">−{file.removed}</span>}
    </div>
  );
  return (
    <CollapsiblePrimitive.Root
      open={expanded}
      onOpenChange={setExpanded}
      render={<section className="task-changes" aria-label={t("timeline.changes")} />}
    >
      <Icon icon={GitCompareArrows} size={14} className="task-changes-icon" />
      {files.length > 3 ? (
        <CollapsiblePrimitive.Trigger
          data-state={expanded ? "open" : "closed"}
          render={<Button variant="ghost" className="task-changes-summary" />}
        >
          <span className="task-changes-count">{t("detail.filesChanged", { count: files.length })}</span>
          <Icon icon={ChevronRight} className="timeline-chevron" />
        </CollapsiblePrimitive.Trigger>
      ) : (
        <span className="task-changes-count">{t("detail.filesChanged", { count: files.length })}</span>
      )}
      <span className="task-changes-sep" aria-hidden="true">·</span>
      {files.slice(0, 3).map(renderFile)}
      {files.length > 3 && (
        <CollapsiblePrimitive.Panel className="task-changes-more" data-state={expanded ? "open" : "closed"}>
          {files.slice(3).map(renderFile)}
        </CollapsiblePrimitive.Panel>
      )}
    </CollapsiblePrimitive.Root>
  );
}
