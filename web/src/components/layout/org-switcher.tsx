import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, Check } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrgs } from "@/hooks/orgs";
import { cn } from "@/lib/utils";

// AVATAR_HUES colour org initials; the hue is stable per name. Each pair is an AA-checked tag pair.
const AVATAR_HUES = [
  "bg-tag-orange-bg text-tag-orange-text",
  "bg-tag-blue-bg text-tag-blue-text",
  "bg-tag-green-bg text-tag-green-text",
  "bg-tag-purple-bg text-tag-purple-text",
  "bg-tag-pink-bg text-tag-pink-text",
  "bg-tag-yellow-bg text-tag-yellow-text",
  "bg-tag-teal-bg text-tag-teal-text",
];

function hueFor(name: string): string {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

// OrgAvatar is the coloured initial tile for an org.
export function OrgAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("grid size-5 shrink-0 place-items-center rounded-md text-[11px] font-semibold", hueFor(name), className)}
    >
      {name.trim().charAt(0).toUpperCase() || "?"}
    </span>
  );
}

// OrgSwitcher changes the scope of the console. Switching drops every cached query first, so no
// data from the previous org can render under the new scope.
export function OrgSwitcher({ org }: { org: string }) {
  const orgs = useOrgs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const current = orgs.data?.find((o) => o.slug === org);
  const name = current?.name ?? org;

  function switchTo(slug: string) {
    if (slug === org) return;
    qc.clear();
    void navigate({ to: "/$org", params: { org: slug } });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Switch org"
        className="flex h-10 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-xl px-2 text-sm text-text outline-none transition-colors duration-[160ms] hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <OrgAvatar name={name} className="size-7 rounded-lg text-[13px]" />
        <span className="min-w-0 flex-1 truncate text-left font-semibold">{name}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(orgs.data ?? []).map((o) => (
          <DropdownMenuItem key={o.slug} onSelect={() => switchTo(o.slug)} className="justify-between">
            <span className="flex min-w-0 items-center gap-2">
              <OrgAvatar name={o.name} />
              <span className="truncate">{o.name}</span>
            </span>
            {o.slug === org ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
