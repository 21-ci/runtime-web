import * as React from "react";

import { cn } from "@/lib/utils";

// Card is the default container: hairline, 10px radius, faint shadow, 20px padding.
function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("min-w-0 rounded-lg border border-line bg-surface p-5 shadow-card", className)} {...props} />;
}

function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("mb-3 flex items-center gap-3", className)} {...props} />;
}

function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("min-w-0 break-words text-[15px] font-semibold text-text", className)} {...props} />;
}

function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("min-w-0 break-words text-sm text-muted", className)} {...props} />;
}

export { Card, CardDescription, CardHeader, CardTitle };
