import type { ComponentProps } from "react";
import { ChevronDown } from "lucide-react";
import { Icon } from "./index";

/** The single-choice/dropdown trigger, also used to open compound choice popovers. */
export default function ChoiceTrigger({ children, ...props }: ComponentProps<"button">) {
  return <button type="button" {...props} className="select-trigger"><span>{children}</span><Icon icon={ChevronDown} /></button>;
}
