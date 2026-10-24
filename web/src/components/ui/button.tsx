import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-sm border border-transparent text-sm font-medium transition-colors duration-[120ms] ease-ui disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-primary hover:bg-accent-hover",
        secondary: "border-line-strong bg-surface text-text shadow-[0_1px_2px_rgba(15,15,15,0.06)] hover:bg-hover",
        ghost: "bg-transparent text-text hover:bg-hover active:bg-active",
        danger: "bg-danger-soft text-danger-text hover:bg-danger-soft/80",
      },
      size: {
        default: "h-7 px-2.5",
        sm: "h-6 gap-1.5 px-2 text-[13px]",
        icon: "size-7 px-0",
        "icon-sm": "size-6 px-0",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size }), className)}
        {...props}
      />
    );
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
