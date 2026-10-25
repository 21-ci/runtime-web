import { useState, type FormEvent } from "react";
import { KeyRound, Trash2 } from "lucide-react";
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
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

import { useDeleteSecret, useSaveSecret, useSecrets, type SecretMeta } from "./hooks";

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

// SecretsPanel lists secret names and sets or replaces values. A value is sent once and never
// read back, so the page never renders one.
// canWrite false (role lacks app.secrets.write) lists names only: no set, replace or delete.
export function SecretsPanel({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const secrets = useSecrets(org, app);
  const save = useSaveSecret(org, app);
  const remove = useDeleteSecret(org, app);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingDelete, setPendingDelete] = useState<SecretMeta | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const value = String(data.get("value") ?? "");
    const next: Record<string, string> = {};
    if (!NAME_PATTERN.test(name)) next.name = "Use letters, digits and underscores, starting with a letter.";
    if (value === "") next.value = "Enter a value.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    save.mutate(
      { name, value },
      {
        onSuccess: () => {
          form.reset();
          toast.success(`Saved ${name}.`);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid") {
            setErrors(err.fieldErrors());
          } else if (!(err instanceof ApiError)) {
            toast.error("Could not save the secret. Try again.");
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
        toast.success(`Deleted ${name}.`);
      },
    });
  }

  return (
    <section aria-labelledby="secrets-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header>
        <h2 id="secrets-heading" className="text-[15px] font-semibold">
          Secrets
        </h2>
        <p className="text-sm text-muted">
          Values are write-only. You can set or replace a secret, but nothing shows its value after saving.
        </p>
      </header>

      {secrets.isError ? (
        <QueryError
          error={secrets.error}
          onRetry={() => void secrets.refetch()}
          notFoundTitle="App not found"
          notFoundDescription="It may have been deleted or you lack access."
        />
      ) : secrets.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : secrets.data.length === 0 ? (
        <EmptyState bare entity="secrets"
          icon={KeyRound}
          title="No secrets yet"
          description="Secrets hold API keys and passwords your app reads at run time."
          action={
            canWrite ? (
            <Button
              variant="secondary"
              onClick={() => document.querySelector<HTMLInputElement>('input[name="name"]')?.focus()}
            >
              Add a secret
            </Button>
            ) : undefined
          }
        />
      ) : (
        <ul aria-label="Secret names" className="divide-y divide-line rounded-lg border border-line">
          {secrets.data.map((s) => (
            <li key={s.name} className="group flex h-10 items-center justify-between gap-3 px-4 text-sm">
              <span className="flex min-w-0 items-center gap-2 font-mono text-[13px] font-medium">
                <KeyRound className="size-3.5 shrink-0 text-tag-brown-text" aria-hidden="true" />
                <span className="truncate" title={s.name}>
                  {s.name}
                </span>
              </span>
              <span className="flex shrink-0 items-center gap-3">
                <span className="hidden text-[12px] text-muted sm:inline">Updated {new Date(s.updated_at).toLocaleDateString()}</span>
                {canWrite ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => setPendingDelete(s)}
                  >
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <p className="text-[13px] font-medium">Set or replace a secret</p>
        <FormField
          label="Name"
          name="name"
          autoComplete="off"
          spellCheck={false}
          error={errors.name}
        />
        <FormField
          label="Value"
          name="value"
          type="password"
          autoComplete="new-password"
          error={errors.value}
        />
        <div>
          <Button type="submit" variant="default" disabled={save.isPending}>
            Save secret
          </Button>
        </div>
      </AuthForm>
      ) : null}

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {pendingDelete?.name}?</DialogTitle>
            <DialogDescription>
              Apps that read this secret fail until you set it again. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingDelete(null)}>
              Cancel
            </Button>
            <Button variant="danger-solid" onClick={confirmDelete} disabled={remove.isPending}>
              Delete secret
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
