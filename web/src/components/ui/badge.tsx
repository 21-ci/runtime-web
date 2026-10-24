import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1 h-5.5 rounded-full px-2 text-[12px] font-medium [&_svg]:size-3 whitespace-nowrap",
  {
    variants: {
      variant: {
        default: "bg-tag-gray-bg text-tag-gray-text",
        success: "bg-tag-green-bg text-tag-green-text",
        danger: "bg-tag-red-bg text-tag-red-text",
        outline: "border border-line-strong text-muted",
        accent: "bg-tag-orange-bg text-tag-orange-text",
        warning: "bg-tag-yellow-bg text-tag-yellow-text",
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
