import { useState } from "react";
import { Trash2, Users } from "lucide-react";
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
import { ROLE_LABEL, assignableRoles } from "./roles";

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

  function changeRole(m: Member, next: OrgRole) {
    setRole.mutate(
      { user: m.user.id, role: next },
      {
        onSuccess: () => toast.success(`${m.user.name} is now ${ROLE_LABEL[next].toLowerCase()}.`),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "last_owner") toast.error("An org needs at least one owner.");
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
        toast.success(`Removed ${name}.`);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.code === "last_owner") toast.error("An org needs at least one owner.");
        else handleMutationError(err);
      },
    });
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="members-heading" className="flex flex-col gap-4">
        <header>
          <h2 id="members-heading" className="text-sm font-semibold">
            Members
          </h2>
          <p className="text-sm text-muted">Roles set what a member can do across the org.</p>
        </header>

        {members.isError ? (
          <QueryError error={members.error} onRetry={() => void members.refetch()} notFoundTitle="Org not found" />
        ) : members.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : members.data.length === 0 ? (
          <EmptyState icon={Users} title="No members" description="Invite a teammate to get started." />
        ) : (
          <ul aria-label="Members" className="divide-y divide-line rounded-md border border-line bg-surface">
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
                        {grants.map(([p, r]) => `${p}: ${r}`).join(", ")}
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
                          <SelectTrigger aria-label={`Role for ${m.user.email}`} className="h-[34px] w-auto min-w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {assignableRoles(role).map((r) => (
                              <SelectItem key={r} value={r}>
                                {ROLE_LABEL[r]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove ${m.user.email}`}
                          onClick={() => setPendingRemove(m)}
                        >
                          <Trash2 className="size-4" aria-hidden />
                        </Button>
                      </>
                    ) : (
                      <Badge variant="outline">{ROLE_LABEL[m.role]}</Badge>
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
            <DialogTitle>Remove {pendingRemove?.user.name}?</DialogTitle>
            <DialogDescription>They lose access to every project in this org.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={remove.isPending}>
              Remove member
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
