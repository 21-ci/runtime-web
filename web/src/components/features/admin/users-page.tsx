import { MoreHorizontal, Search, UserRound, Users } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { QueryError } from "@/components/features/empty/query-error";

import {
  errorMessage,
  useAdminUsers,
  useDeleteAdminUser,
  usePatchAdminUser,
  useResetAdminPassword,
  useResetAdminTotp,
  type AdminUser,
} from "./admin-api";
import { ConfirmDialog } from "./confirm-dialog";
import { InvitesPanel } from "./invites-panel";
import { CreateUserDialog, InviteDialog, SecretDialog } from "./user-dialogs";

type UserAction = { kind: "resetPassword" | "reset2fa" | "delete"; user: AdminUser };

// UsersPage is the instance user directory: create users (temporary password or invite link),
// disable, reset password or 2FA, and soft delete. Destructive actions wait behind a dialog.
export function UsersPage() {
  const { t } = useTranslation(["admin", "common"]);
  const [search, setSearch] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [action, setAction] = useState<UserAction | null>(null);
  const [actionError, setActionError] = useState<string | undefined>();
  const [secret, setSecret] = useState<{ user: AdminUser; value: string } | null>(null);

  const users = useAdminUsers(search.trim());
  const patch = usePatchAdminUser();
  const resetPassword = useResetAdminPassword();
  const resetTotp = useResetAdminTotp();
  const remove = useDeleteAdminUser();
  const items = users.data?.pages.flatMap((p) => p.items) ?? [];

  function closeAction() {
    setAction(null);
    setActionError(undefined);
  }

  function runAction() {
    if (!action) return;
    const { user } = action;
    setActionError(undefined);
    const onError = (err: unknown) => setActionError(errorMessage(err));

    if (action.kind === "resetPassword") {
      resetPassword.mutate(user.id, {
        onSuccess: (res) => {
          closeAction();
          setSecret({ user, value: res.temp_password });
        },
        onError,
      });
    } else if (action.kind === "reset2fa") {
      resetTotp.mutate(user.id, {
        onSuccess: () => {
          closeAction();
          toast.success(t("users.toast.twoFactorReset", { name: user.name }));
        },
        onError,
      });
    } else {
      remove.mutate(user.id, {
        onSuccess: () => {
          closeAction();
          toast.success(t("users.toast.deleted", { name: user.name }));
        },
        onError,
      });
    }
  }

  function toggleDisabled(user: AdminUser) {
    patch.mutate(
      { id: user.id, body: { disabled: !user.disabled } },
      {
        onSuccess: () =>
          toast.success(
            user.disabled ? t("users.toast.enabled", { name: user.name }) : t("users.toast.disabled", { name: user.name }),
          ),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  const pendingLoad = users.isPending;

  function actionTitle(a: UserAction) {
    switch (a.kind) {
      case "resetPassword":
        return t("users.dialog.resetPasswordTitle", { name: a.user.name });
      case "reset2fa":
        return t("users.dialog.reset2faTitle", { name: a.user.name });
      case "delete":
        return t("users.dialog.deleteTitle", { name: a.user.name });
    }
  }

  function actionConfirm(a: UserAction) {
    switch (a.kind) {
      case "resetPassword":
        return t("users.dialog.resetPasswordConfirm");
      case "reset2fa":
        return t("users.dialog.reset2faConfirm");
      case "delete":
        return t("users.dialog.deleteConfirm");
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        icon={Users}
        entity="admin"
        title={t("users.title")}
        description={t("users.description")}
        actions={
          <>
            <Button variant="secondary" onClick={() => setInviteOpen(true)}>
              {t("users.createInvite")}
            </Button>
            <Button variant="default" onClick={() => setCreateOpen(true)}>
              {t("users.newUser")}
            </Button>
          </>
        }
      />

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input
          type="search"
          aria-label={t("users.search")}
          placeholder={t("users.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {users.isError ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} notFoundTitle={t("users.notFound")} />
      ) : pendingLoad ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState entity="members"
          icon={UserRound}
          title={search ? t("users.empty.noMatch") : t("users.empty.noUsers")}
          description={search ? t("users.empty.tryOther") : t("users.empty.create")}
          action={
            search ? undefined : (
              <Button variant="default" onClick={() => setCreateOpen(true)}>{t("users.newUser")}</Button>
            )
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("users.columns.name")}</TableHead>
              <TableHead>{t("users.columns.email")}</TableHead>
              <TableHead>{t("users.columns.status")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common:actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="whitespace-nowrap font-medium">{u.name}</TableCell>
                <TableCell className="whitespace-nowrap">{u.email}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.instance_admin ? <Badge variant="info">{t("users.badges.instanceAdmin")}</Badge> : null}
                    {u.disabled ? <Badge variant="danger">{t("users.badges.disabled")}</Badge> : null}
                    {u.totp_enabled ? (
                      <Badge variant="success">{t("users.badges.twoFactorOn")}</Badge>
                    ) : (
                      <Badge variant="outline">{t("users.badges.twoFactorOff")}</Badge>
                    )}
                    {u.must_change_password ? <Badge variant="outline">{t("users.badges.mustChange")}</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={t("users.actionsFor", { name: u.name })}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => toggleDisabled(u)}>
                        {u.disabled ? t("users.menu.enable") : t("users.menu.disable")}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setAction({ kind: "resetPassword", user: u })}>
                        {t("users.menu.resetPassword")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!u.totp_enabled}
                        onSelect={() => setAction({ kind: "reset2fa", user: u })}
                      >
                        {t("users.menu.reset2fa")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-danger-text"
                        onSelect={() => setAction({ kind: "delete", user: u })}
                      >
                        {t("users.menu.delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {users.hasNextPage ? (
        <div>
          <Button variant="secondary" onClick={() => void users.fetchNextPage()} disabled={users.isFetchingNextPage}>
            {t("users.loadMore")}
          </Button>
        </div>
      ) : null}

      <InvitesPanel />

      <CreateUserDialog open={createOpen} onOpenChange={setCreateOpen} />
      <InviteDialog open={inviteOpen} onOpenChange={setInviteOpen} />

      {action ? (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && closeAction()}
          title={actionTitle(action)}
          description={<DescriptionFor action={action} />}
          confirmLabel={actionConfirm(action)}
          onConfirm={runAction}
          pending={resetPassword.isPending || resetTotp.isPending || remove.isPending}
          error={actionError}
          typedValue={action.kind === "delete" ? action.user.email : undefined}
        />
      ) : null}

      {secret ? (
        <SecretDialog
          open
          onClose={() => setSecret(null)}
          title={t("users.tempPasswordTitle", { name: secret.user.name })}
          label={t("tempPassword")}
          value={secret.value}
          note={t("users.tempPasswordNote", { email: secret.user.email, name: secret.user.name })}
        />
      ) : null}
    </div>
  );
}

function DescriptionFor({ action }: { action: UserAction }) {
  const { t } = useTranslation(["admin", "common"]);
  switch (action.kind) {
    case "resetPassword":
      return <p>{t("users.dialog.resetPasswordBody")}</p>;
    case "reset2fa":
      return <p>{t("users.dialog.reset2faBody")}</p>;
    case "delete":
      return (
        <>
          <p>{t("users.dialog.deleteBody")}</p>
          <p>{t("users.dialog.cannotUndo")}</p>
        </>
      );
  }
}
