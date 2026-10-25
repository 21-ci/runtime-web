import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

// Buttons are quiet 6px-radius controls: one accent-filled primary per view, bordered white
// secondaries, ghost for toolbars, soft red for destructive rows and solid red inside confirms.
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border text-sm font-medium transition-[background-color,color,border-color,box-shadow] duration-[140ms] ease-ui disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        default: "border-transparent bg-accent text-on-primary shadow-card hover:bg-accent-hover",
        secondary: "border-line-strong bg-surface-2 text-text shadow-card hover:bg-hover",
        ghost: "border-transparent bg-transparent text-text hover:bg-hover active:bg-active",
        danger: "border-transparent bg-danger-soft text-danger-text hover:bg-danger-soft/80",
        "danger-solid": "border-transparent bg-danger text-on-danger hover:bg-danger/90",
        link: "h-auto border-transparent bg-transparent px-0 text-accent underline-offset-4 hover:underline",
      },
      size: {
        default: "h-8 px-3",
        sm: "h-7 gap-1 px-2.5 text-[13px]",
        lg: "h-9 px-4",
        icon: "size-8 px-0",
        "icon-sm": "size-7 px-0",
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
    return <Comp ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
