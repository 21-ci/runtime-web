import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as React from "react";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

type Variant = "underline" | "segmented";
const VariantContext = React.createContext<Variant>("underline");

// TabsList defaults to underline tabs on a hairline (page sections). `variant="segmented"` is the
// compact pill track for small toggles (Light / Dark, Last day / week).
const TabsList = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: Variant }
>(({ className, variant = "underline", ...props }, ref) => (
  <VariantContext.Provider value={variant}>
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        variant === "underline"
          ? "flex h-9 items-end gap-4 overflow-x-auto border-b border-line [scrollbar-width:none]"
          : "inline-flex h-8 items-center gap-0.5 rounded-md bg-panel-2 p-0.5",
        className,
      )}
      {...props}
    />
  </VariantContext.Provider>
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const variant = React.useContext(VariantContext);
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex cursor-pointer items-center justify-center whitespace-nowrap text-sm font-medium text-muted outline-none transition-[background-color,color,box-shadow,border-color] duration-[140ms] ease-ui hover:text-text focus-visible:ring-2 focus-visible:ring-focus disabled:pointer-events-none disabled:opacity-50",
        variant === "underline"
          ? "-mb-px h-9 border-b-2 border-transparent px-1 data-[state=active]:border-text data-[state=active]:text-text"
          : "h-full rounded-[5px] px-3 text-[13px] data-[state=active]:bg-surface-2 data-[state=active]:text-text data-[state=active]:shadow-card",
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-4 outline-none", className)} {...props} />
));
TabsContent.displayName = "TabsContent";

export { Tabs, TabsContent, TabsList, TabsTrigger };
