import { cloneElement, type CSSProperties, type ReactElement } from "react";

/** Temporary zero-Radix passthrough while Wave 3B migrates remaining popups to Base UI. */
export function TransientLayer({
  children,
}: {
  children: ReactElement<{ style?: CSSProperties }>;
  onDismiss?: () => void;
  isAnchor?: (target: Element) => boolean;
}) {
  return cloneElement(children, {
    style: { ...children.props.style, zIndex: 65, pointerEvents: "auto" },
  });
}
