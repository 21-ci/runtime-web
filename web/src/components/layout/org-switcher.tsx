import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronsUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { LetterTile, hueFor } from "@/components/ui/icon-tile";
import { useOrgs } from "@/hooks/orgs";
import { cn } from "@/lib/utils";

// OrgAvatar is the coloured initial tile for an org or a person; the hue is stable per name.
export function OrgAvatar({ name, className, solid = false }: { name: string; className?: string; solid?: boolean }) {
  return <LetterTile label={name} hue={hueFor(name)} size="xs" solid={solid} className={cn("rounded-md", className)} />;
}

// OrgSwitcher changes the scope of the console. Switching drops every cached query first, so no
// data from the previous org can render under the new scope.
export function OrgSwitcher({ org }: { org: string }) {
  const orgs = useOrgs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const current = orgs.data?.find((o) => o.slug === org);
  const name = current?.name ?? org;
  const { t } = useTranslation("shell");

  function switchTo(slug: string) {
    if (slug === org) return;
    qc.clear();
    void navigate({ to: "/$org", params: { org: slug } }).then(() => {
      // Anything the old scope refetched while the route changed is dropped too.
      qc.removeQueries({ predicate: (q) => q.queryKey.includes(org) });
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("orgSwitcher.switch")}
        className="flex h-9 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-text outline-none transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <OrgAvatar name={name} solid className="size-6 rounded-md text-[12px]" />
        <span className="min-w-0 flex-1 truncate text-left font-semibold">{name}</span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[228px]">
        <DropdownMenuLabel>{t("orgSwitcher.organizations")}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {(orgs.data ?? []).map((o) => (
          <DropdownMenuItem key={o.slug} onSelect={() => switchTo(o.slug)} className="justify-between">
            <span className="flex min-w-0 items-center gap-2">
              <OrgAvatar name={o.name} solid />
              <span className="truncate">{o.name}</span>
            </span>
            {o.slug === org ? <Check aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
