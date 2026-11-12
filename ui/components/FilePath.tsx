import { Tooltip as HoverHelp } from "./ui/index";
import { filePathParts } from "../state/activityModel";

export default function FilePath({ path, project }: { path: string; project?: string | null }) {
  const { fullPath, displayPath, directory, filename } = filePathParts(path, project);
  return <HoverHelp text={fullPath}><span className="file-path" aria-label={displayPath}>
    {directory && <span className="file-path-directory" aria-hidden="true">{directory}</span>}
    <span className="file-path-name" aria-hidden="true">{filename}</span>
  </span></HoverHelp>;
}
