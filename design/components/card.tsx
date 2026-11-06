import { Frame } from "sdg";
const forms = [
  { name: "default", text: "卡片内容" },
  { name: "reply", text: "Reply content" },
] as const;
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
      class={`flex w-full min-w-0 flex-col gap-4 rounded-card text-text ${padded ? "p-4" : "py-4"} ${variant === "reply" ? "bg-surface" : "bg-surface-subtle"} ${extra}`}
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
export default () =>
  forms.map(({ name, text }) => (
    <Frame name={name} width={560}>
      <Card variant={name}>
        <div class="flex h-[88px] items-center justify-center text-caption font-mono text-text-tertiary">
          {text}
        </div>
      </Card>
    </Frame>
  ));
