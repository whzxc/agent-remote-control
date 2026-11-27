import type { ReactNode } from "react";
import { Frame } from "adg";
import {
  Card as KitCard,
  CardContent as KitCardContent,
  CardHeader as KitCardHeader,
  cn,
} from "@/components/kit";
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
    <KitCard
      padded={padded}
      className={cn(
        !padded && "py-4",
        variant === "reply" ? "rounded-card bg-surface" : "bg-surface",
        extra,
      )}
    >
      {children}
    </KitCard>
  );
}

export function CardHeader({ children }: { children?: ReactNode }) {
  return (
    <KitCardHeader className="flex-col items-stretch gap-2 pt-0">
      {children}
    </KitCardHeader>
  );
}

export function CardContent({ children }: { children?: ReactNode }) {
  return <KitCardContent className="pb-0">{children}</KitCardContent>;
}

export default () => [
  ...cardForms.map(({ name, variant, text }) => (
    <Frame key={name} name={name} width={560}>
      <Card variant={variant}>
        <div className="flex h-[88px] items-center justify-center font-mono text-caption text-text-tertiary">
          {text}
        </div>
      </Card>
    </Frame>
  )),
  ...[
    { name: "card-header", Part: CardHeader },
    { name: "card-content", Part: CardContent },
  ].map(({ name, Part }) => (
    <Frame key={name} name={name} width={560}>
      <div className="w-full bg-surface text-text">
        <Part>{cardForms[0].text}</Part>
      </div>
    </Frame>
  )),
];
