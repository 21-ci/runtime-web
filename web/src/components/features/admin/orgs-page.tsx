import { Building2, MoreHorizontal } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";

import {
  errorMessage,
  lastDays,
  useAdminOrgs,
  useCreateAdminOrg,
  useDeleteAdminOrg,
  useOrgUsage,
  useRenameAdminOrg,
  useUserOptions,
  type AdminOrg,
} from "./admin-api";
import { ConfirmDialog } from "./confirm-dialog";
import { SelectField } from "./user-dialogs";

type OrgAction = { kind: "rename" | "delete"; org: AdminOrg };

// OrgsPage lists every organization with 30-day usage. Creating an org picks its owner from the
// user list; deleting is refused by the API while the org still holds projects or apps.
export function OrgsPage() {
  const orgs = useAdminOrgs();
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<OrgAction | null>(null);

  return (
    <section aria-labelledby="orgs-heading" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="orgs-heading" className="text-lg font-semibold">
          Organizations
        </h2>
        <div className="ml-auto">
          <Button variant="default" onClick={() => setCreateOpen(true)}>New organization</Button>
        </div>
      </div>

      {orgs.isError ? (
        <QueryError error={orgs.error} onRetry={() => void orgs.refetch()} notFoundTitle="Organizations not found" />
      ) : orgs.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : (orgs.data ?? []).length === 0 ? (
        <EmptyState
          icon={Building2}
          title="No organizations yet"
          description="Create an organization and pick its owner from the users."
          action={<Button variant="default" onClick={() => setCreateOpen(true)}>New organization</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Usage, last 30 days</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(orgs.data ?? []).map((org) => (
              <OrgRow key={org.id} org={org} onAction={setAction} />
            ))}
          </TableBody>
        </Table>
      )}

      <CreateOrgDialog open={createOpen} onOpenChange={setCreateOpen} />
      {action?.kind === "rename" ? <RenameOrgDialog org={action.org} onClose={() => setAction(null)} /> : null}
      {action?.kind === "delete" ? <DeleteOrgDialog org={action.org} onClose={() => setAction(null)} /> : null}
    </section>
  );
}

function OrgRow({ org, onAction }: { org: AdminOrg; onAction: (action: OrgAction) => void }) {
  return (
    <TableRow>
      <TableCell className="font-semibold">{org.name}</TableCell>
      <TableCell className="font-mono text-sm">{org.slug}</TableCell>
      <TableCell>
        <OrgUsageCell slug={org.slug} />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={`Actions for ${org.name}`}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction({ kind: "rename", org })}>Rename</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-danger-text" onSelect={() => onAction({ kind: "delete", org })}>
              Delete organization
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

// OrgUsageCell sums the org's daily usage for the last 30 days.
function OrgUsageCell({ slug }: { slug: string }) {
  const range = useMemo(() => lastDays(30), []);
  const usage = useOrgUsage(slug, range);
  if (usage.isPending) return <Skeleton className="h-4 w-40" />;
  if (usage.isError) return <span className="text-sm text-muted">Usage unavailable</span>;
  const rows = usage.data ?? [];
  const invocations = rows.reduce((sum, r) => sum + r.invocations, 0);
  const egress = rows.reduce((sum, r) => sum + r.egress_bytes, 0);
  return (
    <span className="text-sm">
      {invocations.toLocaleString()} invocations, {formatBytes(egress)} egress
    </span>
  );
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const users = useUserOptions();
  const create = useCreateAdminOrg();

  function close(next: boolean) {
    if (!next) {
      setErrors({});
      create.reset();
    }
    onOpenChange(next);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const owner = String(form.get("owner") ?? "");
    const next: Record<string, string> = {};
    if (!slug) next.slug = "Enter a slug.";
    if (!name) next.name = "Enter a name.";
    if (!owner) next.owner = "Pick an owner.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    create.mutate(
      { slug, name, owner_user_id: owner },
      {
        onSuccess: () => {
          toast.success(`Organization ${name} created`);
          close(false);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "slug_taken") {
            setErrors({ slug: "This slug is already taken." });
            return;
          }
          const fields = err instanceof ApiError ? err.fieldErrors() : {};
          if (Object.keys(fields).length > 0) setErrors(fields);
          else toast.error(errorMessage(err));
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New organization</DialogTitle>
          <DialogDescription>The owner can add members, projects and apps.</DialogDescription>
        </DialogHeader>
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label="Slug" name="slug" autoComplete="off" error={errors.slug} />
          <FormField label="Name" name="name" autoComplete="off" error={errors.name} />
          <SelectField label="Owner" name="owner" error={errors.owner}>
            <option value="">Choose a user</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} ({u.email})
              </option>
            ))}
          </SelectField>
          <DialogFooter>
            <Button type="submit" variant="default" disabled={create.isPending}>
              Create organization
            </Button>
          </DialogFooter>
        </AuthForm>
      </DialogContent>
    </Dialog>
  );
}

function RenameOrgDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const rename = useRenameAdminOrg();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError("Enter a name.");
      return;
    }
    rename.mutate(
      { slug: org.slug, name },
      {
        onSuccess: () => {
          toast.success("Organization renamed");
          onClose();
        },
        onError: (err) => setError(errorMessage(err)),
      },
    );
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename {org.name}</DialogTitle>
          <DialogDescription>The slug stays the same, so existing links keep working.</DialogDescription>
        </DialogHeader>
        <AuthForm errors={error ? { name: error } : {}} onSubmit={onSubmit}>
          <FormField label="Name" name="name" defaultValue={org.name} autoComplete="off" error={error} />
          <DialogFooter>
            <Button type="submit" variant="default" disabled={rename.isPending}>
              Save name
            </Button>
          </DialogFooter>
        </AuthForm>
      </DialogContent>
    </Dialog>
  );
}

// DeleteOrgDialog is irreversible, so the slug must be typed. A 409 org_not_empty keeps the dialog
// open with the reason.
function DeleteOrgDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const [error, setError] = useState<string | undefined>();
  const remove = useDeleteAdminOrg();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Delete ${org.name}?`}
      description={
        <>
          <p>Only empty organizations can be deleted. Remove its projects and apps first.</p>
          <p>This cannot be undone.</p>
        </>
      }
      confirmLabel="Delete organization"
      typedValue={org.slug}
      pending={remove.isPending}
      error={error}
      onConfirm={() =>
        remove.mutate(org.slug, {
          onSuccess: () => {
            toast.success(`${org.name} deleted`);
            onClose();
          },
          onError: (err) =>
            setError(
              err instanceof ApiError && err.code === "org_not_empty"
                ? "This organization still has projects or apps. Remove them first."
                : errorMessage(err),
            ),
        })
      }
    />
  );
}
