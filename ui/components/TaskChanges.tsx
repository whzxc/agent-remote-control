import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { Collapsible } from "radix-ui";
import type { AgentTimelineEntry } from "../types";
import { t } from "../i18n";
import { changedFiles } from "../state/taskProjection";
import FilePath from "./FilePath";
import { Button, Icon } from "./ui";

export function ChangedFiles({ entries, project }: { entries: AgentTimelineEntry[]; project?: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const files = changedFiles(entries);
  if (!files.length) return null;
  const renderFile = (file: typeof files[number]) => <div className="task-change-row" key={file.path}><FilePath path={file.path} project={project} />
      {(file.operation === "create" || file.operation === "delete") && <span className="task-file-operation" data-operation={file.operation}>{t(file.operation === "create" ? "detail.fileCreated" : "detail.fileDeleted")}</span>}
      {file.added !== undefined && <span className="task-added">+{file.added}</span>}
      {file.removed !== undefined && <span className="task-removed">−{file.removed}</span>}
    </div>;
  return <Collapsible.Root open={expanded} onOpenChange={setExpanded} asChild><section className="task-changes" aria-label={t("timeline.changes")} data-single={files.length === 1 || undefined}>
    {files.length > 3 ? <Collapsible.Trigger asChild><Button variant="ghost" className="task-changes-summary"><strong>{t("detail.filesChanged", { count: files.length })}</strong><Icon icon={ChevronRight} className="timeline-chevron" /></Button></Collapsible.Trigger>
      : <strong>{t("detail.filesChanged", { count: files.length })}</strong>}
    {files.slice(0, 3).map(renderFile)}
    {files.length > 3 && <Collapsible.Content className="task-changes-more">{files.slice(3).map(renderFile)}</Collapsible.Content>}
  </section></Collapsible.Root>;
}
