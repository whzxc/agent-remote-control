import type { ComponentProps } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Icon } from "./index";

/** The single-choice/dropdown trigger, also used to open compound choice popovers. */
export default function ChoiceTrigger({ children, side = "bottom", ...props }: ComponentProps<"button"> & { side?: "bottom" | "right" }) {
  return <button type="button" {...props} className="select-trigger"><span>{children}</span><Icon icon={side === "right" ? ChevronRight : ChevronDown} /></button>;
}
