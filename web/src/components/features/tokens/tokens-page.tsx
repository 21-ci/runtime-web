import { useId, useState, type FormEvent } from "react";
import { Copy, KeyRound, Trash2 } from "lucide-react";
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
import { useProjects } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";
import type { OrgRole } from "@/lib/types";

import { useCreateToken, useRevokeToken, useTokens, type Token } from "./hooks";
import { EXPIRY_OPTIONS, scopesForRole } from "./scopes";

const DAY_MS = 24 * 60 * 60 * 1000;

// TokensPage manages org-level custom tokens. Only owners and admins reach the actions; the
// scope picker offers only what the caller's role may grant.
export function TokensPage({ org, role }: { org: string; role: OrgRole }) {
  const canManage = role === "owner" || role === "admin";
  const tokens = useTokens(org, canManage);
  const [pendingRevoke, setPendingRevoke] = useState<Token | null>(null);
  const revoke = useRevokeToken(org);

  if (!canManage) {
    return (
      <EmptyState
        icon={KeyRound}
        title="Tokens are for admins"
        description="Tokens need the owner or admin role. Ask an admin to create one."
      />
    );
  }

  function confirmRevoke() {
    if (!pendingRevoke) return;
    const name = pendingRevoke.name;
    revoke.mutate(pendingRevoke.id, {
      onSuccess: () => {
        setPendingRevoke(null);
        toast.success(`Revoked ${name}.`);
      },
    });
  }

  return (
    <section aria-labelledby="tokens-heading" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="tokens-heading" className="text-sm font-semibold">
            API tokens
          </h2>
          <p className="text-sm text-muted">
            Tokens let CI, the CLI and other tools act for this org. A token's secret is shown once.
          </p>
        </div>
        <NewTokenDialog org={org} role={role} />
      </header>

      {tokens.isError ? (
        <QueryError error={tokens.error} onRetry={() => void tokens.refetch()} notFoundTitle="Org not found" />
      ) : tokens.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : tokens.data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No tokens yet"
          description="Create a token for a CI job or a script."
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead>Access</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead>Last used</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokens.data.map((t) => (
              <TableRow key={t.id}>
                <TableCell className="font-medium">
                  {t.name}
                  <span className="block text-xs text-muted">by {t.created_by.name}</span>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {t.scopes.map((s) => (
                      <Badge key={s} variant="outline">
                        {s}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell>{describeAccess(t.projects, t.environments)}</TableCell>
                <TableCell>{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : "Never"}</TableCell>
                <TableCell>{t.last_used_at ? new Date(t.last_used_at).toLocaleString() : "Not yet"}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="sm" aria-label={`Revoke ${t.name}`} onClick={() => setPendingRevoke(t)}>
                    <Trash2 className="size-4" aria-hidden />
                    Revoke
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
            <DialogTitle>Revoke {pendingRevoke?.name}?</DialogTitle>
            <DialogDescription>Anything using this token stops working right away.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRevoke} disabled={revoke.isPending}>
              Revoke token
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

// NewTokenDialog runs the create form, then shows the secret once. Closing the dialog drops it.
function NewTokenDialog({ org, role }: { org: string; role: OrgRole }) {
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
    if (!name) next.name = "Enter a name so you can recognize this token later.";
    if (scopes.length === 0) next.scopes = "Pick at least one scope.";
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
          else toast.error("Could not create the token. Try again.");
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button variant="default">New token</Button>
      </DialogTrigger>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Token {created.name} created</DialogTitle>
              <DialogDescription>Copy the secret now. You will not be able to see it again.</DialogDescription>
            </DialogHeader>
            <div className="flex items-center gap-2 rounded-[6px] border border-line bg-panel p-3">
              <code className="min-w-0 flex-1 break-all font-mono text-sm">{created.secret}</code>
              <Button
                variant="secondary"
                size="sm"
                aria-label="Copy token secret"
                onClick={() => void navigator.clipboard.writeText(created.secret)}
              >
                <Copy className="size-4" aria-hidden />
                Copy
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New token</DialogTitle>
              <DialogDescription>Choose what this token may do. Scopes are limited to your role.</DialogDescription>
            </DialogHeader>
            <AuthForm errors={errors} onSubmit={onSubmit}>
              <FormField label="Name" name="name" autoComplete="off" error={errors.name} />
              <fieldset className="flex flex-col gap-2">
                <legend className="mb-1 text-sm font-medium">Scopes</legend>
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
                  <legend className="mb-1 text-sm font-medium">Projects (leave empty for all)</legend>
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
                  <legend className="mb-1 text-sm font-medium">Environments (leave empty for all)</legend>
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
                <Label htmlFor={expiryId}>Expires</Label>
                <select
                  id={expiryId}
                  name="expiry"
                  defaultValue="never"
                  className="h-[34px] rounded-[6px] border border-line bg-surface px-2 text-sm"
                >
                  {EXPIRY_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <DialogFooter>
                <Button type="submit" variant="default" disabled={create.isPending}>
                  Create token
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
function describeAccess(projects: string[], environments: string[]): string {
  const p = projects.length === 0 ? "All projects" : projects.join(", ");
  return environments.length === 0 ? p : `${p} (${environments.join(", ")})`;
}
