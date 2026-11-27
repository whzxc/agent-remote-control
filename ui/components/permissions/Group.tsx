import { type ReactNode } from "react";

export function Group({
  title,
  children,
  subtle = false,
}: {
  title?: ReactNode;
  children: ReactNode;
  subtle?: boolean;
}) {
  return (
    <section className="settings-group" data-subtle={subtle || undefined}>
      {title && <h2>{title}</h2>}
      <div>{children}</div>
    </section>
  );
}
