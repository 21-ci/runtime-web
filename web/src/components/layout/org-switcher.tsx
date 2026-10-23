import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ChevronsUpDown, Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useOrgs } from "@/hooks/orgs";

// OrgSwitcher changes the scope of the console. Switching drops every cached query first, so no
// data from the previous org can render under the new scope.
export function OrgSwitcher({ org }: { org: string }) {
  const orgs = useOrgs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const current = orgs.data?.find((o) => o.slug === org);

  function switchTo(slug: string) {
    if (slug === org) return;
    qc.clear();
    void navigate({ to: "/$org", params: { org: slug } });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="w-full justify-between px-2" aria-label="Switch org">
          <span className="truncate font-semibold">{current?.name ?? org}</span>
          <ChevronsUpDown className="size-4 text-muted" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel>Organizations</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(orgs.data ?? []).map((o) => (
          <DropdownMenuItem key={o.slug} onSelect={() => switchTo(o.slug)} className="justify-between">
            <span className="truncate">{o.name}</span>
            {o.slug === org ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
