import { locale, t } from "../../i18n";
import { filePathParts, projectLabelParts } from "../../lib/projectPath";
import { Tooltip } from "./index";
import "./ProjectPath.css";

export function ProjectLabel({ name, path }: { name?: string | null; path?: string | null }) {
  locale.use();
  const project = projectLabelParts(name, path);
  if (!project) return null;
  const label = t("project.label");
  const description = [label, project.name, project.path === project.name ? undefined : project.path].filter(Boolean).join(" · ");
  return <Tooltip text={description}><span className="project-label" role="img" aria-label={description}>
    <strong dir="auto">{project.name}</strong>
  </span></Tooltip>;
}

export function FilePath({ path, project, cwd, full = false }: { path: string; project?: string | null; cwd?: string | null; full?: boolean }) {
  const { fullPath, displayPath, directory, filename } = filePathParts(path, project, cwd);
  if (full) return <span className="file-path-full" dir="ltr">{fullPath}</span>;
  return <Tooltip text={fullPath}><span className="file-path" dir="ltr" role="img" aria-label={displayPath}>
    {directory && <span className="file-path-directory" aria-hidden="true">{directory}</span>}
    <span className="file-path-name" aria-hidden="true">{filename}</span>
  </span></Tooltip>;
}
