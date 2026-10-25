import { useState } from "react";
import { Trash2, Users } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { InvitesPanel } from "@/components/features/invites/invites-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { handleMutationError } from "@/lib/query";
import type { OrgRole } from "@/lib/types";

import { useMembers, useRemoveMember, useSetMemberRole, type Member } from "./hooks";
import { ROLE_KEY, assignableRoles, isProjectRole } from "./roles";

// MembersPage lists org members with their roles and project grants, and hosts the invites panel.
// Owner-only controls (granting or changing owner, removing an owner) are hidden from admins; the
// server enforces the same rules.
export function MembersPage({ org, role }: { org: string; role: OrgRole }) {
  const members = useMembers(org);
  const setRole = useSetMemberRole(org);
  const remove = useRemoveMember(org);
  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const canManage = role === "owner" || role === "admin";
  const callerIsOwner = role === "owner";
  const { t } = useTranslation(["members", "common"]);

  function changeRole(m: Member, next: OrgRole) {
    setRole.mutate(
      { user: m.user.id, role: next },
      {
        onSuccess: () => toast.success(t("toast.roleChanged", { context: next, name: m.user.name })),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "last_owner") toast.error(t("toast.lastOwner"));
          else handleMutationError(err);
        },
      },
    );
  }

  function confirmRemove() {
    if (!pendingRemove) return;
    const name = pendingRemove.user.name;
    remove.mutate(pendingRemove.user.id, {
      onSuccess: () => {
        setPendingRemove(null);
        toast.success(t("toast.removed", { name }));
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === "last_owner") toast.error(t("toast.lastOwner"));
        else handleMutationError(err);
      },
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="members-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
        <header className="flex items-start justify-between gap-3">
          <div>
            <h2 id="members-heading" className="text-[15px] font-semibold">
              {t("title")}
            </h2>
            <p className="text-sm text-muted">{t("description")}</p>
          </div>
          {members.data ? (
            <span className="shrink-0 text-sm tabular-nums text-muted">{t("count", { count: members.data.length })}</span>
          ) : null}
        </header>

        {members.isError ? (
          <QueryError error={members.error} onRetry={() => void members.refetch()} notFoundTitle={t("orgNotFound")} />
        ) : members.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : members.data.length === 0 ? (
          <EmptyState entity="members" icon={Users} title={t("empty.title")} description={t("empty.description")} />
        ) : (
          <ul aria-label={t("title")} className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
            {members.data.map((m) => {
              // Admins cannot touch owner rows at all.
              const locked = !callerIsOwner && m.role === "owner";
              const grants = Object.entries(m.grants);
              return (
                <li key={m.user.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{m.user.name}</span>
                    <span className="truncate text-muted" title={m.user.email}>
                      {m.user.email}
                    </span>
                    {grants.length > 0 ? (
                      <span className="block text-xs text-muted">
                        {grants.map(([p, r]) => t("grant", { project: p, role: isProjectRole(r) ? t(`projectRoles.${r}`) : r })).join(", ")}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    {canManage && !locked ? (
                      <>
                        <Select
                          value={m.role}
                          disabled={setRole.isPending}
                          onValueChange={(v) => changeRole(m, v as OrgRole)}
                        >
                          <SelectTrigger aria-label={t("roleFor", { email: m.user.email })} className="h-[34px] w-auto min-w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {assignableRoles(role).map((r) => (
                              <SelectItem key={r} value={r}>
                                {t(ROLE_KEY[r])}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={t("removeLabel", { email: m.user.email })}
                          onClick={() => setPendingRemove(m)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Badge variant="outline">{t(ROLE_KEY[m.role])}</Badge>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {canManage ? <InvitesPanel org={org} role={role} /> : null}

      <Dialog open={pendingRemove !== null} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("remove.title", { name: pendingRemove?.user.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("remove.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRemove(null)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={remove.isPending}>
              {t("remove.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
