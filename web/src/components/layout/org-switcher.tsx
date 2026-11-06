import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Building2, Check, ChevronsUpDown, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ROLE_KEY } from "@/components/features/members/roles";
import { IconTile, hueFor } from "@/components/ui/icon-tile";
import { useOrgs } from "@/hooks/orgs";
import { cn } from "@/lib/utils";

// OrgAvatar and PersonAvatar are coloured icon tiles; the hue is stable per name.
export function OrgAvatar({ name, className, solid = false }: { name: string; className?: string; solid?: boolean }) {
  return <IconTile icon={Building2} hue={hueFor(name)} size="xs" solid={solid} className={cn("rounded-md", className)} />;
}

export function PersonAvatar({ name, className, solid = false }: { name: string; className?: string; solid?: boolean }) {
  return <IconTile icon={UserRound} hue={hueFor(name)} size="xs" solid={solid} className={cn("rounded-md", className)} />;
}

// OrgSwitcher changes the scope of the console. Switching drops every cached query first, so no
// data from the previous org can render under the new scope.
export function OrgSwitcher({ org }: { org: string }) {
  const orgs = useOrgs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const current = orgs.data?.find((o) => o.slug === org);
  const name = current?.name ?? org;
  const { t } = useTranslation(["shell", "members"]);

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
        className="flex h-11 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 text-sm text-text outline-none transition-colors duration-[120ms] hover:bg-hover data-[state=open]:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <OrgAvatar name={name} className="size-8 rounded-lg text-[13px]" />
        <span className="grid min-w-0 flex-1 text-left leading-tight group-data-[collapsible=icon]:hidden">
          <span className="truncate font-semibold">{name}</span>
          {current?.role ? <span className="truncate text-[12px] text-muted">{t(ROLE_KEY[current.role])}</span> : null}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-muted group-data-[collapsible=icon]:hidden" aria-hidden="true" />
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
