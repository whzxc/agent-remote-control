import { items } from "../fixtures/nav-capsule";
import { Frame, Icon } from "adg";

export function NavCapsule({
  items: entries = items,
  active = "permissions",
}: {
  items?: { id: string; icon: string; label: string }[];
  active?: string;
}) {
  return (
    <nav class="inline-flex items-center gap-1 px-[6px] py-1 rounded-[22px] bg-surface-raised shadow-lg">
      {entries.map((item) => (
        <button
          aria-label={item.label}
          class={
            "flex items-center justify-center size-9 rounded-card " +
            String(item.id === active ? "bg-surface-sunken text-text" : "text-text-secondary")
          }
        >
          <Icon name={item.icon} size={18} />
        </button>
      ))}
    </nav>
  );
}
export default () => (
  <Frame name="default">
    <NavCapsule />
  </Frame>
);
