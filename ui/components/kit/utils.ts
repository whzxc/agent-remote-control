import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        {
          text: [
            "caption",
            "meta",
            "small",
            "body",
            "title",
            "display",
            "code-display",
          ],
        },
      ],
      rounded: [
        {
          rounded: [
            "rail",
            "progress",
            "disclosure",
            "tile",
            "field",
            "switch",
            "inset",
            "control",
            "card",
            "panel",
            "pill",
            "circle",
            "badge",
            "kit-field",
            "popover",
            "kit-card",
            "dialog",
            "shell",
          ],
        },
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function stateClass<State>(
  base: string,
  className: string | ((state: State) => string | undefined) | undefined,
): string | ((state: State) => string) {
  return typeof className === "function"
    ? (state: State) => cn(base, className(state))
    : cn(base, className);
}
