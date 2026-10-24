import { cva, type VariantProps } from "class-variance-authority";
import type { LucideIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Hue is one of the tag palettes; each tile pairs tag-*-bg with tag-*-text (AA-checked).
export type Hue = "gray" | "brown" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "red" | "teal";

const HUE: Record<Hue, string> = {
  gray: "bg-tag-gray-bg text-tag-gray-text",
  brown: "bg-tag-brown-bg text-tag-brown-text",
  orange: "bg-tag-orange-bg text-tag-orange-text",
  yellow: "bg-tag-yellow-bg text-tag-yellow-text",
  green: "bg-tag-green-bg text-tag-green-text",
  blue: "bg-tag-blue-bg text-tag-blue-text",
  purple: "bg-tag-purple-bg text-tag-purple-text",
  pink: "bg-tag-pink-bg text-tag-pink-text",
  red: "bg-tag-red-bg text-tag-red-text",
  teal: "bg-tag-teal-bg text-tag-teal-text",
};

// ENTITY_HUE gives every entity type its own colour, used by the sidebar, page headers and
// empty states so the same thing always looks the same.
export const ENTITY_HUE = {
  overview: "orange",
  apps: "blue",
  projects: "yellow",
  logs: "teal",
  triggers: "pink",
  keys: "brown",
  tokens: "brown",
  secrets: "brown",
  env: "green",
  domains: "green",
  members: "purple",
  invites: "purple",
  admin: "red",
  audit: "gray",
  security: "teal",
  settings: "gray",
  versions: "blue",
} as const satisfies Record<string, Hue>;

export type Entity = keyof typeof ENTITY_HUE;

const tileVariants = cva("inline-grid shrink-0 place-items-center [&_svg]:shrink-0 [&_svg]:stroke-2", {
  variants: {
    size: {
      xs: "size-5 rounded-md [&_svg]:size-3",
      sm: "size-6 rounded-md [&_svg]:size-3.5",
      md: "size-8 rounded-lg [&_svg]:size-4",
      lg: "size-11 rounded-xl [&_svg]:size-5",
    },
  },
  defaultVariants: { size: "sm" },
});

export interface IconTileProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tileVariants> {
  icon: LucideIcon;
  hue?: Hue;
  entity?: Entity;
}

function IconTile({ icon: Icon, hue, entity, size, className, ...props }: IconTileProps) {
  const h: Hue = hue ?? (entity ? ENTITY_HUE[entity] : "gray");
  return (
    <span aria-hidden="true" className={cn(tileVariants({ size }), HUE[h], className)} {...props}>
      <Icon />
    </span>
  );
}

export { IconTile };
