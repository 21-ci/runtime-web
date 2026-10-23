import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-[5px] px-2 py-0.5 text-xs font-semibold whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-panel-2 text-text",
        success: "bg-green text-on-success",
        danger: "bg-danger-soft text-danger-text",
        outline: "border border-line-strong text-muted",
        info: "bg-accent-soft text-text",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
