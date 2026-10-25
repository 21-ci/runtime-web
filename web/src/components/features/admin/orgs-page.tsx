import { Building2, MoreHorizontal } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
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
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
import { formatBytes, formatCount } from "@/lib/format";

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
import { NONE_VALUE, SelectField } from "./user-dialogs";

type OrgAction = { kind: "rename" | "delete"; org: AdminOrg };

// OrgsPage lists every organization with 30-day usage. Creating an org picks its owner from the
// user list; deleting is refused by the API while the org still holds projects or apps.
export function OrgsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const orgs = useAdminOrgs();
  const [createOpen, setCreateOpen] = useState(false);
  const [action, setAction] = useState<OrgAction | null>(null);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        icon={Building2}
        entity="admin"
        title={t("orgs.title")}
        description={t("orgs.description")}
        actions={
          <Button variant="default" onClick={() => setCreateOpen(true)}>
            {t("orgs.new")}
          </Button>
        }
      />

      {orgs.isError ? (
        <QueryError error={orgs.error} onRetry={() => void orgs.refetch()} notFoundTitle={t("orgs.notFound")} />
      ) : orgs.isPending ? (
        <div className="flex flex-col gap-2" aria-busy="true">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : (orgs.data ?? []).length === 0 ? (
        <EmptyState entity="admin"
          icon={Building2}
          title={t("orgs.emptyTitle")}
          description={t("orgs.emptyDescription")}
          action={<Button variant="default" onClick={() => setCreateOpen(true)}>{t("orgs.new")}</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("orgs.columns.name")}</TableHead>
              <TableHead>{t("orgs.columns.slug")}</TableHead>
              <TableHead>{t("orgs.columns.usage")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common:actions")}</span>
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
    </div>
  );
}

function OrgRow({ org, onAction }: { org: AdminOrg; onAction: (action: OrgAction) => void }) {
  const { t } = useTranslation("admin");
  return (
    <TableRow>
      <TableCell className="whitespace-nowrap font-medium">{org.name}</TableCell>
      <TableCell className="whitespace-nowrap font-mono text-sm">{org.slug}</TableCell>
      <TableCell>
        <OrgUsageCell slug={org.slug} />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" aria-label={t("orgs.actionsFor", { name: org.name })}>
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => onAction({ kind: "rename", org })}>{t("orgs.rename")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-danger-text" onSelect={() => onAction({ kind: "delete", org })}>
              {t("orgs.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </TableCell>
    </TableRow>
  );
}

// OrgUsageCell sums the org's daily usage for the last 30 days.
function OrgUsageCell({ slug }: { slug: string }) {
  const { t } = useTranslation("admin");
  const range = useMemo(() => lastDays(30), []);
  const usage = useOrgUsage(slug, range);
  if (usage.isPending) return <Skeleton className="h-4 w-40" />;
  if (usage.isError) return <span className="text-sm text-muted">{t("orgs.usageUnavailable")}</span>;
  const rows = usage.data ?? [];
  const invocations = rows.reduce((sum, r) => sum + r.invocations, 0);
  const egress = rows.reduce((sum, r) => sum + r.egress_bytes, 0);
  return (
    <span className="text-sm">
      {t("orgs.usage", { invocations: formatCount(invocations), egress: formatBytes(egress) })}
    </span>
  );
}

function CreateOrgDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useTranslation(["admin", "common"]);
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
    const owner = String(form.get("owner") ?? "") === NONE_VALUE ? "" : String(form.get("owner") ?? "");
    const next: Record<string, string> = {};
    if (!slug) next.slug = t("orgs.create.slugRequired");
    if (!name) next.name = t("orgs.create.nameRequired");
    if (!owner) next.owner = t("orgs.create.ownerRequired");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    create.mutate(
      { slug, name, owner_user_id: owner },
      {
        onSuccess: () => {
          toast.success(t("orgs.create.created", { name }));
          close(false);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "slug_taken") {
            setErrors({ slug: t("orgs.create.slugTaken") });
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
          <DialogTitle>{t("orgs.create.title")}</DialogTitle>
          <DialogDescription>{t("orgs.create.description")}</DialogDescription>
        </DialogHeader>
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label={t("orgs.create.slug")} name="slug" autoComplete="off" error={errors.slug} />
          <FormField label={t("orgs.create.name")} name="name" autoComplete="off" error={errors.name} />
          <SelectField
            label={t("orgs.create.owner")}
            name="owner"
            error={errors.owner}
            defaultValue={NONE_VALUE}
            options={[
              { value: NONE_VALUE, label: t("orgs.create.chooseUser") },
              ...(users.data ?? []).map((u) => ({ value: u.id, label: `${u.name} (${u.email})` })),
            ]}
          />
          <DialogFooter>
            <Button type="submit" variant="default" disabled={create.isPending}>
              {t("orgs.create.submit")}
            </Button>
          </DialogFooter>
        </AuthForm>
      </DialogContent>
    </Dialog>
  );
}

function RenameOrgDialog({ org, onClose }: { org: AdminOrg; onClose: () => void }) {
  const { t } = useTranslation(["admin", "common"]);
  const [error, setError] = useState<string | undefined>();
  const rename = useRenameAdminOrg();

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name") ?? "").trim();
    if (!name) {
      setError(t("orgs.renameDialog.nameRequired"));
      return;
    }
    rename.mutate(
      { slug: org.slug, name },
      {
        onSuccess: () => {
          toast.success(t("orgs.renameDialog.renamed"));
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
          <DialogTitle>{t("orgs.renameDialog.title", { name: org.name })}</DialogTitle>
          <DialogDescription>{t("orgs.renameDialog.description")}</DialogDescription>
        </DialogHeader>
        <AuthForm errors={error ? { name: error } : {}} onSubmit={onSubmit}>
          <FormField label={t("orgs.renameDialog.name")} name="name" defaultValue={org.name} autoComplete="off" error={error} />
          <DialogFooter>
            <Button type="submit" variant="default" disabled={rename.isPending}>
              {t("orgs.renameDialog.submit")}
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
  const { t } = useTranslation(["admin", "common"]);
  const [error, setError] = useState<string | undefined>();
  const remove = useDeleteAdminOrg();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={t("orgs.deleteDialog.title", { name: org.name })}
      description={
        <>
          <p>{t("orgs.deleteDialog.description")}</p>
          <p>{t("orgs.deleteDialog.cannotUndo")}</p>
        </>
      }
      confirmLabel={t("orgs.deleteDialog.confirm")}
      typedValue={org.slug}
      pending={remove.isPending}
      error={error}
      onConfirm={() =>
        remove.mutate(org.slug, {
          onSuccess: () => {
            toast.success(t("orgs.deleteDialog.deleted", { name: org.name }));
            onClose();
          },
          onError: (err) =>
            setError(
              err instanceof ApiError && err.code === "org_not_empty"
                ? t("orgs.deleteDialog.notEmpty")
                : errorMessage(err),
            ),
        })
      }
    />
  );
}
