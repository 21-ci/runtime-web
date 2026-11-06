import { cva, type VariantProps } from "class-variance-authority";
import { Boxes, Building2, FolderOpen, GitBranch, Users, type LucideIcon } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Hue is one of the tag palettes; each tile pairs tag-*-bg with tag-*-text (AA-checked), or uses
// tag-*-solid with a white glyph for the solid variant.
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

const SOLID: Record<Hue, string> = {
  gray: "bg-tag-gray-solid text-white",
  brown: "bg-tag-brown-solid text-white",
  orange: "bg-tag-orange-solid text-white",
  yellow: "bg-tag-yellow-solid text-white",
  green: "bg-tag-green-solid text-white",
  blue: "bg-tag-blue-solid text-white",
  purple: "bg-tag-purple-solid text-white",
  pink: "bg-tag-pink-solid text-white",
  red: "bg-tag-red-solid text-white",
  teal: "bg-tag-teal-solid text-white",
};

// ENTITY_HUE gives every entity type its own colour, used by the sidebar, page headers and
// empty states so the same thing always looks the same.
export const ENTITY_HUE = {
  overview: "orange",
  apps: "blue",
  code: "blue",
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
  versions: "purple",
} as const satisfies Record<string, Hue>;

export type Entity = keyof typeof ENTITY_HUE;

const tileVariants = cva("inline-grid shrink-0 place-items-center [&_svg]:shrink-0 [&_svg]:stroke-2", {
  variants: {
    size: {
      xs: "size-5 rounded-[5px] [&_svg]:size-3",
      sm: "size-6 rounded-md [&_svg]:size-3.5",
      md: "size-8 rounded-lg [&_svg]:size-4",
      lg: "size-11 rounded-xl [&_svg]:size-5",
      xl: "size-14 rounded-2xl [&_svg]:size-7",
    },
  },
  defaultVariants: { size: "sm" },
});

export interface IconTileProps extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof tileVariants> {
  icon: LucideIcon;
  hue?: Hue;
  entity?: Entity;
  /** Saturated fill with a white glyph (Framer-style category icon). */
  solid?: boolean;
}

function IconTile({ icon: Icon, hue, entity, size, solid = false, className, ...props }: IconTileProps) {
  const h: Hue = hue ?? (entity ? ENTITY_HUE[entity] : "gray");
  return (
    <span aria-hidden="true" className={cn(tileVariants({ size }), solid ? SOLID[h] : HUE[h], className)} {...props}>
      <Icon />
    </span>
  );
}

// hueFor picks a stable hue for a name (org and app avatars).
const HUES: Hue[] = ["blue", "green", "purple", "orange", "pink", "teal", "yellow", "red"];
export function hueFor(name: string): Hue {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return HUES[h % HUES.length];
}

const ENTITY_GLYPH = { app: Boxes, project: FolderOpen, org: Building2, member: Users, branch: GitBranch } as const;

export type EntityKind = keyof typeof ENTITY_GLYPH;

export interface EntityTileProps extends Omit<IconTileProps, "icon" | "hue" | "entity"> {
  kind: EntityKind;
  /** The object's name: its tint identifies it among others of the same kind. */
  name: string;
}

// EntityTile identifies an app, project, org, member or branch by a glyph for its kind and a hue from its name.
function EntityTile({ kind, name, ...props }: EntityTileProps) {
  return <IconTile icon={ENTITY_GLYPH[kind]} hue={hueFor(name)} {...props} />;
}

export { EntityTile, IconTile };
