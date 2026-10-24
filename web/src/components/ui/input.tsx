import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(
        "flex h-9 w-full min-w-0 rounded-lg border border-line bg-field px-3 text-sm text-text transition-[background-color,border-color,box-shadow] duration-[160ms] ease-ui outline-none placeholder:text-muted hover:border-line-strong focus-visible:bg-surface aria-invalid:border-danger focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = "Input";

export { Input };
