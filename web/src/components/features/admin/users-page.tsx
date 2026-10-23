import { MoreHorizontal, Search, UserRound } from "lucide-react";
import { useState } from "react";
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
          toast.success(`2FA reset for ${user.name}`);
        },
        onError,
      });
    } else {
      remove.mutate(user.id, {
        onSuccess: () => {
          closeAction();
          toast.success(`${user.name} was deleted`);
        },
        onError,
      });
    }
  }

  function toggleDisabled(user: AdminUser) {
    patch.mutate(
      { id: user.id, body: { disabled: !user.disabled } },
      {
        onSuccess: () => toast.success(user.disabled ? `${user.name} enabled` : `${user.name} disabled`),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  const pendingLoad = users.isPending;

  return (
    <section aria-labelledby="users-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="users-heading" className="text-lg font-semibold">
          Users
        </h2>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => setInviteOpen(true)}>
            Create invite link
          </Button>
          <Button onClick={() => setCreateOpen(true)}>New user</Button>
        </div>
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input
          type="search"
          aria-label="Search users"
          placeholder="Search by name or email"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="pl-9"
        />
      </div>

      {users.isError ? (
        <QueryError error={users.error} onRetry={() => void users.refetch()} notFoundTitle="Users not found" />
      ) : pendingLoad ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={UserRound}
          title={search ? "No users match" : "No users yet"}
          description={search ? "Try another name or email." : "Create the first user or send an invite link."}
          action={
            search ? undefined : (
              <Button onClick={() => setCreateOpen(true)}>New user</Button>
            )
          }
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Email</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-semibold">{u.name}</TableCell>
                <TableCell className="break-all">{u.email}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {u.instance_admin ? <Badge variant="info">Instance admin</Badge> : null}
                    {u.disabled ? <Badge variant="danger">Disabled</Badge> : null}
                    {u.totp_enabled ? (
                      <Badge variant="success">2FA on</Badge>
                    ) : (
                      <Badge variant="outline">2FA off</Badge>
                    )}
                    {u.must_change_password ? <Badge variant="outline">Must change password</Badge> : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`Actions for ${u.name}`}>
                        <MoreHorizontal aria-hidden="true" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => toggleDisabled(u)}>
                        {u.disabled ? "Enable user" : "Disable user"}
                      </DropdownMenuItem>
                      <DropdownMenuItem onSelect={() => setAction({ kind: "resetPassword", user: u })}>
                        Reset password
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={!u.totp_enabled}
                        onSelect={() => setAction({ kind: "reset2fa", user: u })}
                      >
                        Reset 2FA
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-danger-text"
                        onSelect={() => setAction({ kind: "delete", user: u })}
                      >
                        Delete user
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
            Load more users
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
          title={titleFor(action)}
          description={<DescriptionFor action={action} />}
          confirmLabel={confirmLabelFor(action)}
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
          title={`Temporary password for ${secret.user.name}`}
          label="Temporary password"
          value={secret.value}
          note={`Share it with ${secret.user.email} now. It is shown once and cannot be retrieved later. ${secret.user.name} must change it at first sign-in, and their other sessions are signed out.`}
        />
      ) : null}
    </section>
  );
}

function titleFor(action: UserAction) {
  switch (action.kind) {
    case "resetPassword":
      return `Reset password for ${action.user.name}?`;
    case "reset2fa":
      return `Reset 2FA for ${action.user.name}?`;
    case "delete":
      return `Delete ${action.user.name}?`;
  }
}

function confirmLabelFor(action: UserAction) {
  switch (action.kind) {
    case "resetPassword":
      return "Reset password";
    case "reset2fa":
      return "Reset 2FA";
    case "delete":
      return "Delete user";
  }
}

function DescriptionFor({ action }: { action: UserAction }) {
  switch (action.kind) {
    case "resetPassword":
      return (
        <p>
          A new temporary password is generated and every session of this user is signed out. The old password
          stops working.
        </p>
      );
    case "reset2fa":
      return (
        <p>
          Two-factor sign-in is removed and every session of this user is signed out. They can enroll again from
          their security page.
        </p>
      );
    case "delete":
      return (
        <>
          <p>
            Deleting disables the account, signs it out everywhere, and anonymizes its name and email. Past audit
            entries stay, but they show the anonymized account.
          </p>
          <p>This cannot be undone.</p>
        </>
      );
  }
}
