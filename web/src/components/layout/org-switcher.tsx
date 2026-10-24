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

// OrgAvatar is the Notion-style initial square for an org.
export function OrgAvatar({ name }: { name: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center rounded-sm bg-panel-2 text-[11px] font-medium text-text"
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
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm px-2 text-sm text-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <OrgAvatar name={name} />
        <span className="min-w-0 flex-1 truncate text-left font-medium">{name}</span>
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
