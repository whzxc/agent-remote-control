import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Card } from "./card";
import "./QuotaCard.css";

export function QuotaCard({ children }: { children: ReactNode }) {
  return <Card className="quota-card">{children}</Card>;
}
/** The inline disclosure in quota readings and credit details. */
export function QuotaDetailAction({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { ref?: Ref<HTMLButtonElement> }) {
  return <button type="button" {...props} className="quota-detail-action">{children}</button>;
}
