import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex h-5 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-[12px] font-medium leading-none [&_svg]:size-3",
  {
    variants: {
      variant: {
        default: "bg-tag-gray-bg text-tag-gray-text",
        success: "bg-tag-green-bg text-tag-green-text",
        danger: "bg-tag-red-bg text-tag-red-text",
        warning: "bg-tag-yellow-bg text-tag-yellow-text",
        info: "bg-accent-soft text-text",
        accent: "bg-tag-orange-bg text-tag-orange-text",
        blue: "bg-tag-blue-bg text-tag-blue-text",
        purple: "bg-tag-purple-bg text-tag-purple-text",
        teal: "bg-tag-teal-bg text-tag-teal-text",
        outline: "border border-line-strong text-muted",
      },
    },
    defaultVariants: { variant: "default" },
  },
);

const DOT: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-tag-gray-solid",
  success: "bg-tag-green-solid",
  danger: "bg-tag-red-solid",
  warning: "bg-tag-yellow-solid",
  info: "bg-accent",
  accent: "bg-tag-orange-solid",
  blue: "bg-tag-blue-solid",
  purple: "bg-tag-purple-solid",
  teal: "bg-tag-teal-solid",
  outline: "bg-tag-gray-solid",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badgeVariants> {
  /** Adds a small status dot in the variant colour before the label. */
  dot?: boolean;
}

function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot ? <span aria-hidden="true" className={cn("size-1.5 rounded-full", DOT[variant ?? "default"])} /> : null}
      {children}
    </span>
  );
}

export { Badge, badgeVariants };
