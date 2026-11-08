import { Frame } from "sdg";
import { Button } from "./button";
import { cardForms } from "../fixtures/panels";

export type CardProps = {
  children?: unknown;
  variant?: "default" | "reply";
  padded?: boolean;
  class?: string;
};
export function Card({
  children,
  variant = "default",
  padded = false,
  class: extra = "",
}: CardProps) {
  return (
    <div
      class={`flex w-full min-w-0 flex-col gap-4 rounded-card text-text ${padded ? "p-4" : "py-4"}
        ${variant === "reply" ? "bg-surface" : "bg-surface-subtle"} ${extra}`}
    >
      {children}
    </div>
  );
}
export function CardHeader({ children }: { children?: unknown }) {
  return <div class="flex flex-col gap-2 px-4">{children}</div>;
}
export function CardTitle({ children }: { children?: unknown }) {
  return <div class="font-semibold text-body">{children}</div>;
}
export function CardDescription({ children }: { children?: unknown }) {
  return <div class="text-meta text-text-secondary">{children}</div>;
}
export function CardContent({ children }: { children?: unknown }) {
  return <div class="px-4">{children}</div>;
}
export function CardFooter({ children }: { children?: unknown }) {
  return <div class="flex items-center gap-2 px-4">{children}</div>;
}
export default () => [
  ...cardForms.map(({ name, variant, text }) => (
    <Frame name={name} width={560}>
      <Card variant={variant}>
        <div class="flex h-[88px] items-center justify-center text-caption font-mono text-text-tertiary">
          {text}
        </div>
      </Card>
    </Frame>
  )),
  ...[
    { name: "card-header", Part: CardHeader },
    { name: "card-title", Part: CardTitle },
    { name: "card-description", Part: CardDescription },
    { name: "card-content", Part: CardContent },
    { name: "card-footer", Part: CardFooter },
  ].map(({ name, Part }) => (
    <Frame name={name} width={560}>
      <div class="w-full bg-surface-subtle text-text"><Part>{cardForms[0].text}</Part></div>
    </Frame>
  )),
];

export function PermissionCard() {
  return (
    <Card padded class="gap-4">
      <div class="flex flex-col gap-1">
        <strong class="text-body leading-4 font-semibold">
          Read README.md
        </strong>
        <span class="text-meta leading-3 text-text-secondary">
          仅允许这一次
        </span>
      </div>
      <pre class="flex h-11 items-center rounded-field bg-surface-sunken px-[14px] text-meta font-mono">
        cat README.md
      </pre>
      <div class="flex justify-end gap-2">
        <Button>拒绝</Button>
        <Button disabled class="opacity-42">
          绕过
        </Button>
        <Button variant="primary" class="px-5">
          批准
        </Button>
      </div>
    </Card>
  );
}
