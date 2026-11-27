import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";
import * as React from "react";
import { cn, stateClass } from "./utils";

export type TabsVariant = "default" | "underline";

const TabsListContext = React.createContext<{ variant: TabsVariant }>({
  variant: "default",
});

export function Tabs({
  className,
  ...props
}: TabsPrimitive.Root.Props): React.ReactElement {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={stateClass(
        "flex flex-col gap-3 data-[orientation=vertical]:flex-row",
        className,
      )}
      {...props}
    />
  );
}

export function TabsList({
  variant = "default",
  className,
  children,
  ...props
}: TabsPrimitive.List.Props & {
  variant?: TabsVariant;
}): React.ReactElement {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      data-variant={variant}
      className={stateClass(
        cn(
          "relative z-0 flex items-center text-text-secondary data-[orientation=vertical]:flex-col data-[orientation=vertical]:items-stretch",
          variant === "default"
            ? "w-fit gap-0.5 rounded-popover border border-border bg-surface-subtle p-0.5"
            : "max-w-full gap-4 overflow-x-auto border-b border-border data-[orientation=vertical]:border-b-0 data-[orientation=vertical]:border-r",
        ),
        className,
      )}
      {...props}
    >
      <TabsListContext.Provider value={{ variant }}>
        {children}
      </TabsListContext.Provider>
      <TabsPrimitive.Indicator
        data-slot="tab-indicator"
        className={cn(
          "absolute bottom-0 left-0 h-(--active-tab-height) w-(--active-tab-width) translate-x-(--active-tab-left) -translate-y-(--active-tab-bottom) transition-[width,height,translate] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none",
          variant === "underline"
            ? "z-10 bg-primary data-[orientation=horizontal]:h-0.5 data-[orientation=vertical]:w-0.5"
            : "-z-1 rounded-badge bg-surface-raised shadow-sm",
        )}
      />
    </TabsPrimitive.List>
  );
}

export function TabsTab({
  className,
  ...props
}: TabsPrimitive.Tab.Props): React.ReactElement {
  const { variant } = React.useContext(TabsListContext);
  return (
    <TabsPrimitive.Tab
      data-slot="tabs-tab"
      className={stateClass(
        cn(
          "relative inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap font-medium text-small outline-none transition-[color,background-color,box-shadow] duration-(--motion-fast) ease-(--ease-enter) motion-reduce:transition-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[orientation=vertical]:w-full data-[orientation=vertical]:justify-start data-active:font-semibold data-active:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50",
          variant === "default"
            ? "h-[26px] rounded-badge px-2.5 data-active:bg-surface-raised data-active:shadow-sm [:has(>[data-slot=tab-indicator]:not([hidden]))>&]:bg-transparent! [:has(>[data-slot=tab-indicator]:not([hidden]))>&]:shadow-none!"
            : "border-b-2 border-transparent py-2.5 data-active:border-b-primary [:has(>[data-slot=tab-indicator]:not([hidden]))>&]:border-b-transparent!",
        ),
        className,
      )}
      {...props}
    />
  );
}

export function TabsPanel({
  className,
  ...props
}: TabsPrimitive.Panel.Props): React.ReactElement {
  return (
    <TabsPrimitive.Panel
      data-slot="tabs-content"
      className={stateClass("min-w-0 flex-1 outline-none", className)}
      {...props}
    />
  );
}

export {
  TabsPrimitive,
  TabsTab as TabsTrigger,
  TabsPanel as TabsContent,
};
