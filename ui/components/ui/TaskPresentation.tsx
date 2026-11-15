import type { ComponentProps } from "react";


import { Card } from "./card";
import "./TaskPresentation.css";

export function TaskContentCard({ reply = false, className = "", ...props }: ComponentProps<"section"> & { reply?: boolean }) {
  return <Card asChild padded variant={reply ? "reply" : "default"}><section {...props} className={className} /></Card>;
}
