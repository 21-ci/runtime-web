import { useState, type FormEvent } from "react";
import { KeyRound, Pencil, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { DataTable, type DataColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { SectionCard } from "@/components/ui/section-card";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate } from "@/lib/format";
import { ApiError } from "@/lib/api";

import { UnlinkButton, VaultActions, VaultStatus } from "./vault-ref";
import { useDeleteSecret, useSaveSecret, useSecrets, type SecretMeta } from "./hooks";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// SecretsPanel lists secret names; a sheet sets or replaces a value. A value is sent once and never read back, so the
// page never renders one. canWrite false (role lacks app.secrets.write) lists names only.
export function SecretsPanel({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const secrets = useSecrets(org, app);
  const save = useSaveSecret(org, app);
  const remove = useDeleteSecret(org, app);
  const { t } = useTranslation(["secrets", "common"]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<SecretMeta | null>(null);
  // null: closed; "": a new secret; a name: replacing that secret.
  const [target, setTarget] = useState<string | null>(null);

  function openSheet(name: string) {
    setErrors({});
    setTarget(name);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = target || String(data.get("name") ?? "").trim();
    const value = String(data.get("value") ?? "");
    const next: Record<string, string> = {};
    if (!NAME_PATTERN.test(name)) next.name = t("nameInvalid");
    if (value === "") next.value = t("valueRequired");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(
      { name, value },
      {
        onSuccess: () => {
          setTarget(null);
          toast.success(t("toast.saved", { name }));
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid") {
            setErrors(err.fieldErrors());
          } else if (!(err instanceof ApiError)) {
            toast.error(t("toast.saveFailed"));
          }
        },
      },
    );
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const name = pendingDelete.name;
    remove.mutate(name, {
      onSuccess: () => {
        setPendingDelete(null);
        toast.success(t("toast.deleted", { name }));
      },
    });
  }

  const columns: DataColumn<SecretMeta>[] = [
    {
      key: "name",
      header: t("columns.name"),
      primary: true,
      sortValue: (s) => s.name,
      cell: (s) => (
        <span className="flex min-w-0 items-center gap-2 font-mono text-[13px] font-medium">
          <KeyRound className="size-3.5 shrink-0 text-tag-brown-text" aria-hidden="true" />
          <span className="truncate" title={s.name}>
            {s.name}
          </span>
          <VaultStatus secret={s} />
        </span>
      ),
    },
    {
      key: "updated",
      header: t("columns.updated"),
      align: "right",
      sortValue: (s) => s.updated_at,
      cell: (s) => formatDate(s.updated_at),
    },
    ...(canWrite
      ? [
          {
            key: "actions",
            header: t("common:actions"),
            align: "right" as const,
            cell: (s: SecretMeta) => (
              <span className="inline-flex items-center justify-end gap-1">
                {s.source === "vault" ? (
                  <UnlinkButton org={org} app={app} name={s.name} />
                ) : (
                  <Button variant="ghost" size="icon-sm" aria-label={t("replaceLabel", { name: s.name })} onClick={() => openSheet(s.name)}>
                    <Pencil aria-hidden="true" />
                  </Button>
                )}
                <Button variant="ghost" size="icon-sm" aria-label={t("deleteLabel", { name: s.name })} onClick={() => setPendingDelete(s)}>
                  <Trash2 aria-hidden="true" />
                </Button>
              </span>
            ),
          },
        ]
      : []),
  ];

  const actions = canWrite ? (
    <>
      <VaultActions org={org} app={app} hasRefs={secrets.data?.some((s) => s.source === "vault") === true} />
      <Button variant="secondary" onClick={() => openSheet("")}>
        <Plus aria-hidden="true" /> {t("set")}
      </Button>
    </>
  ) : undefined;

  return (
    <SectionCard title={t("title")} description={t("description")} actions={actions}>
      {secrets.isError ? (
        <QueryError
          error={secrets.error}
          onRetry={() => void secrets.refetch()}
          notFoundTitle={t("appNotFound")}
          notFoundDescription={t("appNotFoundHint")}
        />
      ) : secrets.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : secrets.data.length === 0 ? (
        <EmptyState bare entity="secrets" icon={KeyRound} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <DataTable
          label={t("listLabel")}
          columns={columns}
          rows={secrets.data}
          rowKey={(s) => s.name}
          count={t("count", { count: secrets.data.length })}
        />
      )}

      <Sheet open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <SheetContent className="bg-surface">
          <SheetHeader>
            <SheetTitle>{target ? t("form.replaceTitle", { name: target }) : t("form.title")}</SheetTitle>
            <SheetDescription>{t("form.description")}</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            <AuthForm errors={errors} onSubmit={onSubmit}>
              {target ? null : <FormField label={t("common:name")} name="name" autoComplete="off" spellCheck={false} error={errors.name} />}
              <FormField label={t("form.value")} name="value" type="password" autoComplete="new-password" error={errors.value} />
              <div>
                <Button type="submit" variant="default" disabled={save.isPending}>
                  {t("form.save")}
                </Button>
              </div>
            </AuthForm>
          </div>
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
        title={t("confirm.title", { name: pendingDelete?.name ?? "" })}
        description={<p>{t("confirm.description")}</p>}
        confirmLabel={t("confirm.button")}
        pending={remove.isPending}
        onConfirm={confirmDelete}
      />
    </SectionCard>
  );
}
