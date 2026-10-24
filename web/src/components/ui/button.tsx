import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-full border-0 text-sm font-medium transition-[background-color,color,box-shadow,transform] duration-[160ms] active:scale-[0.98] ease-ui disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-bg [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:stroke-[1.75]",
  {
    variants: {
      variant: {
        default: "bg-accent text-on-primary hover:bg-accent-hover",
        secondary: "bg-secondary text-text hover:bg-secondary-hover",
        ghost: "bg-transparent text-text hover:bg-hover active:bg-active",
        danger: "bg-danger-soft text-danger-text hover:bg-danger-soft/80",
      },
      size: {
        default: "h-8 px-3.5",
        sm: "h-7 gap-1.5 px-3 text-[13px]",
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
