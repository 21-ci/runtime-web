import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QueryError } from "@/components/features/empty/query-error";
import { ROLE_KEY } from "@/components/features/members/roles";
import { formatDate } from "@/lib/format";
import { Mail } from "lucide-react";

import { errorMessage, useAdminInvites, useRevokeAdminInvite, type AdminInvite } from "./admin-api";
import { ConfirmDialog } from "./confirm-dialog";

// InvitesPanel lists pending invite links across all orgs. Revoking one makes its link dead at once,
// so it sits behind a confirm dialog.
export function InvitesPanel() {
  const { t } = useTranslation(["admin", "members", "common"]);
  const invites = useAdminInvites();
  const revoke = useRevokeAdminInvite();
  const [target, setTarget] = useState<AdminInvite | null>(null);
  const [error, setError] = useState<string | undefined>();

  function confirmRevoke() {
    if (!target) return;
    setError(undefined);
    revoke.mutate(target.id, {
      onSuccess: () => {
        toast.success(t("invites.revoked", { email: target.email }));
        setTarget(null);
      },
      onError: (err) => setError(errorMessage(err)),
    });
  }

  return (
    <section aria-labelledby="invites-heading" className="flex flex-col gap-3">
      <h2 id="invites-heading" className="text-[15px] font-semibold">
        {t("invites.title")}
      </h2>
      {invites.isError ? (
        <QueryError error={invites.error} onRetry={() => void invites.refetch()} notFoundTitle={t("invites.notFound")} />
      ) : invites.isPending ? (
        <Skeleton className="h-12" />
      ) : (invites.data ?? []).length === 0 ? (
        <EmptyState entity="invites"
          icon={Mail}
          title={t("invites.empty.title")}
          description={t("invites.empty.description")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common:email")}</TableHead>
              <TableHead>{t("invites.columns.organization")}</TableHead>
              <TableHead>{t("common:role")}</TableHead>
              <TableHead>{t("invites.columns.expires")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common:actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(invites.data ?? []).map((inv) => (
              <TableRow key={inv.id} className="group">
                <TableCell className="break-all">{inv.email}</TableCell>
                <TableCell>{inv.org ? inv.org.name : t("none")}</TableCell>
                <TableCell>{inv.role ? t(ROLE_KEY[inv.role]) : t("none")}</TableCell>
                <TableCell>{formatDate(inv.expires_at)}</TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={t("invites.revokeLabel", { email: inv.email })} onClick={() => setTarget(inv)}>
                    {t("invites.revoke")}
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
          title={t("invites.revokeTitle", { email: target.email })}
          description={<p>{t("invites.revokeDescription")}</p>}
          confirmLabel={t("invites.revokeConfirm")}
          onConfirm={confirmRevoke}
          pending={revoke.isPending}
          error={error}
        />
      ) : null}
    </section>
  );
}
