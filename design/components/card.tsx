import type { ReactNode } from "react";
import { Frame } from "adg";
import { cardForms } from "../fixtures/panels";

export type CardProps = {
  children?: ReactNode;
  variant?: "default" | "reply";
  padded?: boolean;
  className?: string;
};
export function Card({
  children,
  variant = "default",
  padded = false,
  className: extra = "",
}: CardProps) {
  return (
    <div
      className={`flex w-full min-w-0 flex-col gap-4 rounded-card text-text ${padded ? "p-4" : "py-4"}
        ${variant === "reply" ? "bg-surface" : "bg-surface-subtle"} ${extra}`}
    >
      {children}
    </div>
  );
}
export function CardHeader({ children }: { children?: ReactNode }) {
  return <div className="flex flex-col gap-2 px-4">{children}</div>;
}
export function CardContent({ children }: { children?: ReactNode }) {
  return <div className="px-4">{children}</div>;
}
export default () => [
  ...cardForms.map(({ name, variant, text }) => (
    <Frame name={name} width={560}>
      <Card variant={variant}>
        <div className="flex h-[88px] items-center justify-center text-caption font-mono text-text-tertiary">
          {text}
        </div>
      </Card>
    </Frame>
  )),
  ...[
    { name: "card-header", Part: CardHeader },
    { name: "card-content", Part: CardContent },
  ].map(({ name, Part }) => (
    <Frame name={name} width={560}>
      <div className="w-full bg-surface-subtle text-text"><Part>{cardForms[0].text}</Part></div>
    </Frame>
  )),
];
