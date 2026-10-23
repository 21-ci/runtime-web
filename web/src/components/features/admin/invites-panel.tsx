import { useState } from "react";
import { toast } from "sonner";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QueryError } from "@/components/features/empty/query-error";
import { Mail } from "lucide-react";

import { errorMessage, useAdminInvites, useRevokeAdminInvite, type AdminInvite } from "./admin-api";
import { ConfirmDialog } from "./confirm-dialog";

// InvitesPanel lists pending invite links across all orgs. Revoking one makes its link dead at once,
// so it sits behind a confirm dialog.
export function InvitesPanel() {
  const invites = useAdminInvites();
  const revoke = useRevokeAdminInvite();
  const [target, setTarget] = useState<AdminInvite | null>(null);
  const [error, setError] = useState<string | undefined>();

  function confirmRevoke() {
    if (!target) return;
    setError(undefined);
    revoke.mutate(target.id, {
      onSuccess: () => {
        toast.success(`Invite for ${target.email} revoked`);
        setTarget(null);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <section aria-labelledby="invites-heading" className="flex flex-col gap-3">
      <h2 id="invites-heading" className="text-lg font-semibold">
        Pending invites
      </h2>
      {invites.isError ? (
        <QueryError error={invites.error} onRetry={() => void invites.refetch()} notFoundTitle="Invites not found" />
      ) : invites.isPending ? (
        <Skeleton className="h-12" />
      ) : (invites.data ?? []).length === 0 ? (
        <EmptyState
          icon={Mail}
          title="No pending invites"
          description="Create an invite link to add someone without setting a password for them."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Email</TableHead>
              <TableHead>Organization</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(invites.data ?? []).map((inv) => (
              <TableRow key={inv.id}>
                <TableCell className="break-all">{inv.email}</TableCell>
                <TableCell>{inv.org ? inv.org.name : "None"}</TableCell>
                <TableCell>{inv.role ?? "None"}</TableCell>
                <TableCell>{new Date(inv.expires_at).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" aria-label={`Revoke invite for ${inv.email}`} onClick={() => setTarget(inv)}>
                    Revoke
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {target ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setTarget(null);
              setError(undefined);
            }
          }}
          title={`Revoke invite for ${target.email}?`}
          description={<p>The invite link stops working immediately. Create a new one if you still need to add them.</p>}
          confirmLabel="Revoke invite"
          onConfirm={confirmRevoke}
          pending={revoke.isPending}
          error={error}
        />
      ) : null}
    </section>
  );
}
