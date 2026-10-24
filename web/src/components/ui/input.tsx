import * as React from "react";

import { cn } from "@/lib/utils";

const INPUT =
  "flex w-full min-w-0 rounded-md border border-line-strong bg-field text-sm text-text shadow-card transition-[background-color,border-color,box-shadow] duration-[140ms] ease-ui outline-none placeholder:text-muted hover:border-line-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus aria-invalid:border-danger disabled:cursor-not-allowed disabled:opacity-50 read-only:bg-panel";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type = "text", ...props }, ref) => (
    <input ref={ref} type={type} className={cn(INPUT, "h-9 px-3", className)} {...props} />
  ),
);
Input.displayName = "Input";

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  ({ className, ...props }, ref) => (
    <textarea ref={ref} className={cn(INPUT, "min-h-20 px-3 py-2 leading-relaxed", className)} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export { Input, Textarea, INPUT };
