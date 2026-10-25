import { useId, useState, type FormEvent } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useProjects } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";
import { formatDate, formatDateTime } from "@/lib/format";
import type { OrgRole } from "@/lib/types";

import { useCreateToken, useRevokeToken, useTokens, type Token } from "./hooks";
import { EXPIRY_OPTIONS, scopesForRole } from "./scopes";

const DAY_MS = 24 * 60 * 60 * 1000;

// TokensPage manages org-level custom tokens. Only owners and admins reach the actions; the
// scope picker offers only what the caller's role may grant.
export function TokensPage({ org, role }: { org: string; role: OrgRole }) {
  const { t } = useTranslation(["tokens", "common"]);
  const canManage = role === "owner" || role === "admin";
  const tokens = useTokens(org, canManage);
  const [pendingRevoke, setPendingRevoke] = useState<Token | null>(null);
  const revoke = useRevokeToken(org);

  if (!canManage) {
    return (
      <EmptyState entity="tokens"
        icon={KeyRound}
        title={t("adminsOnly.title")}
        description={t("adminsOnly.description")}
      />
    );
  }

  function confirmRevoke() {
    if (!pendingRevoke) return;
    const name = pendingRevoke.name;
    revoke.mutate(pendingRevoke.id, {
      onSuccess: () => {
        setPendingRevoke(null);
        toast.success(t("toast.revoked", { name }));
      },
    });
  }

  return (
    <section aria-labelledby="tokens-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tokens-heading" className="text-[15px] font-semibold">
            {t("section.title")}
          </h2>
          <p className="text-sm text-muted">{t("section.description")}</p>
        </div>
        <NewTokenDialog org={org} role={role} />
      </header>

      {tokens.isError ? (
        <QueryError error={tokens.error} onRetry={() => void tokens.refetch()} notFoundTitle={t("orgNotFound")} />
      ) : tokens.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : tokens.data.length === 0 ? (
        <EmptyState entity="tokens"
          icon={KeyRound}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("common:name")}</TableHead>
              <TableHead>{t("columns.scopes")}</TableHead>
              <TableHead>{t("columns.access")}</TableHead>
              <TableHead>{t("columns.expires")}</TableHead>
              <TableHead>{t("columns.lastUsed")}</TableHead>
              <TableHead>
                <span className="sr-only">{t("common:actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.data.map((tok) => (
              <TableRow key={tok.id}>
                <TableCell className="font-medium">
                  {tok.name}
                  <span className="block text-xs text-muted">{t("createdBy", { name: tok.created_by.name })}</span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {tok.scopes.map((s) => (
                      <Badge key={s} variant="outline">
                        {s}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell>{describeAccess(t("allProjects"), tok.projects, tok.environments)}</TableCell>
                <TableCell>{tok.expires_at ? formatDate(tok.expires_at) : t("expiry.never")}</TableCell>
                <TableCell>{tok.last_used_at ? formatDateTime(tok.last_used_at) : t("lastUsedNever")}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" aria-label={t("revoke.label", { name: tok.name })} onClick={() => setPendingRevoke(tok)}>
                    <Trash2 className="size-4" aria-hidden />
                    {t("revoke.button")}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Dialog open={pendingRevoke !== null} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revoke.title", { name: pendingRevoke?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("revoke.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRevoke(null)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger" onClick={confirmRevoke} disabled={revoke.isPending}>
              {t("revoke.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// NewTokenDialog runs the create form, then shows the secret once. Closing the dialog drops it.
function NewTokenDialog({ org, role }: { org: string; role: OrgRole }) {
  const { t } = useTranslation(["tokens", "common"]);
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [scopes, setScopes] = useState<string[]>([]);
  const [projects, setProjects] = useState<string[]>([]);
  const [environments, setEnvironments] = useState<string[]>([]);
  const create = useCreateToken(org);
  const projectList = useProjects(org);
  // Environments offered are those of the picked projects, or of every project when none is picked.
  const envOptions = [
    ...new Set(
      (projectList.data ?? [])
        .filter((p) => projects.length === 0 || projects.includes(p.slug))
        .flatMap((p) => p.environments),
    ),
  ];
  const scopeOptions = scopesForRole(role);
  const expiryId = useId();

  function reset() {
    setCreated(null);
    setErrors({});
    setScopes([]);
    setProjects([]);
    setEnvironments([]);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function toggle(list: string[], value: string, set: (v: string[]) => void) {
    set(list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get("name") ?? "").trim();
    const expiry = EXPIRY_OPTIONS.find((o) => o.value === String(data.get("expiry") ?? "never"));
    const next: Record<string, string> = {};
    if (!name) next.name = t("errors.name");
    if (scopes.length === 0) next.scopes = t("errors.scopes");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    create.mutate(
      {
        name,
        scopes,
        projects,
        environments: environments.filter((e) => envOptions.includes(e)),
        expires_at: expiry?.days ? Date.now() + expiry.days * DAY_MS : null,
      },
      {
        onSuccess: (res) => setCreated({ name: res.token.name, secret: res.secret }),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid") setErrors(err.fieldErrors());
          else toast.error(t("toast.createFailed"));
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="default">{t("new.button")}</Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("created.title", { name: created.name })}</DialogTitle>
              <DialogDescription>{t("created.description")}</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-panel p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{created.secret}</code>
              <Button
                variant="secondary"
                size="sm"
                aria-label={t("created.copySecret")}
                onClick={() => void navigator.clipboard.writeText(created.secret)}
              >
                <Copy className="size-4" aria-hidden />
                {t("common:copy")}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>{t("common:done")}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("new.title")}</DialogTitle>
              <DialogDescription>{t("new.description")}</DialogDescription>
            </DialogHeader>
            <AuthForm errors={errors} onSubmit={onSubmit}>
              <FormField label={t("common:name")} name="name" autoComplete="off" error={errors.name} />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-[13px] font-medium">{t("form.scopes")}</legend>
                {errors.scopes ? <p className="text-sm text-danger">{errors.scopes}</p> : null}
                <div className="grid grid-cols-2 gap-2">
                  {scopeOptions.map((s) => (
                    <label key={s} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="scopes"
                        value={s}
                        checked={scopes.includes(s)}
                        onChange={() => toggle(scopes, s, setScopes)}
                        className="size-4 accent-accent"
                      />
                      {s}
                    </label>
                  ))}
                </div>
              </fieldset>
              {projectList.data && projectList.data.length > 0 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">{t("form.projects")}</legend>
                  {projectList.data.map((p) => (
                    <label key={p.slug} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="projects"
                        value={p.slug}
                        checked={projects.includes(p.slug)}
                        onChange={() => toggle(projects, p.slug, setProjects)}
                        className="size-4 accent-accent"
                      />
                      {p.name || p.slug}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              {envOptions.length > 0 ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="mb-1 text-sm font-medium">{t("form.environments")}</legend>
                  {envOptions.map((env) => (
                    <label key={env} className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        name="environments"
                        value={env}
                        checked={environments.includes(env)}
                        onChange={() => toggle(environments, env, setEnvironments)}
                        className="size-4 accent-accent"
                      />
                      {env}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={expiryId}>{t("form.expires")}</Label>
                <Select name="expiry" defaultValue="never">
                  <SelectTrigger id={expiryId} className="h-[34px] px-2 text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EXPIRY_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {t(o.labelKey)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <DialogFooter>
                <Button type="submit" variant="default" disabled={create.isPending}>
                  {t("form.submit")}
                </Button>
              </DialogFooter>
            </AuthForm>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// describeAccess summarizes a token's project and environment restriction for the table.
function describeAccess(allProjects: string, projects: string[], environments: string[]): string {
  const p = projects.length === 0 ? allProjects : projects.join(", ");
  return environments.length === 0 ? p : `${p} (${environments.join(", ")})`;
}
