import { SourceMark } from "./SourceMark";
import { Terminal } from "lucide-react";
import type { DispatchSummary } from "../../types";
import { dispatchSourceLabel } from "../../state/taskLineage";
import SourceIcon from "../SourceIcon";
import { Icon } from "../ui";

export { dispatchSourceLabel };
export function SourceBadge({ source, inline = false }: { source: NonNullable<DispatchSummary["controlSource"]>; inline?: boolean }) {
  return <SourceMark label={dispatchSourceLabel(source)} inline={inline}>
    {source.kind === "local-cli" ? <Icon icon={Terminal} /> : <SourceIcon platform={source.kind ?? ""} />}
  </SourceMark>;
}
