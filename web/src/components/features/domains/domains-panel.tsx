import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, RefreshCw, Trash2 } from "lucide-react";
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
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { api, ApiError } from "@/lib/api";

// Shape from docs/api-web.md §8.5.
export type Domain = {
  id: string;
  host: string;
  app: string;
  status: "pending" | "active" | "failed";
  txt_name: string;
  txt_value: string;
  cname_target: string;
  last_checked_at: number | null;
  verified_at: number | null;
  cert_status: "none" | "pending" | "issued" | "error";
  cert_not_after: number | null;
  cert_error: string | null;
  created_at: number;
};

const STATUS_LABEL: Record<Domain["status"], string> = { pending: "Pending", active: "Active", failed: "Failed" };

const CERT_LABEL: Record<Domain["cert_status"], string> = {
  none: "No certificate yet",
  pending: "Certificate pending",
  issued: "Certificate issued",
  error: "Certificate error",
};

function appPath(org: string, app: string) {
  return `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}`;
}

function useDomains(org: string, app: string) {
  return useQuery({
    queryKey: ["domains", org, app],
    queryFn: () => api.get<{ items: Domain[] }>(`${appPath(org, app)}/domains`).then((r) => r.items),
  });
}

function useDomainMutations(org: string, app: string) {
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: ["domains", org, app] });
  return {
    add: useMutation({
      meta: { skipGlobalError: true },
      mutationFn: (host: string) => api.post<Domain>(`${appPath(org, app)}/domains`, { host }),
      onSuccess: invalidate,
    }),
    verify: useMutation({
      mutationFn: (id: string) => api.post<Domain>(`${appPath(org, app)}/domains/${encodeURIComponent(id)}/verify`),
      onSuccess: invalidate,
    }),
    remove: useMutation({
      mutationFn: (id: string) => api.del<void>(`${appPath(org, app)}/domains/${encodeURIComponent(id)}`),
      onSuccess: invalidate,
    }),
  };
}

function CopyButton({ label, value }: { label: string; value: string }) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => toast.success("Copied."),
          () => toast.error("Could not copy. Select the text instead."),
        );
      }}
    >
      <Copy className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function DnsRecord({ host, domain }: { host: string; domain: Domain }) {
  return (
    <div className="flex flex-col gap-3 rounded-[8px] border border-line bg-panel p-3 text-sm">
      <p>
        Add these DNS records for <span className="font-mono">{host}</span>.
      </p>
      <dl className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">TXT name</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.txt_name}</code>
            <CopyButton label="Copy TXT name" value={domain.txt_name} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">TXT value</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.txt_value}</code>
            <CopyButton label="Copy TXT value" value={domain.txt_value} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">CNAME target</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.cname_target}</code>
            <CopyButton label="Copy CNAME target" value={domain.cname_target} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

// DomainsPanel manages custom hosts for one app: DNS instructions, status and certificate state.
// canWrite false (role lacks domains.manage) shows hosts and status only.
export function DomainsPanel({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const domains = useDomains(org, app);
  const { add, verify, remove } = useDomainMutations(org, app);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingRemove, setPendingRemove] = useState<Domain | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const host = String(new FormData(form).get("host") ?? "").trim();
    if (host === "") {
      setErrors({ host: "Enter a host name, for example www.example.com." });
      return;
    }
    setErrors({});
    add.mutate(host, {
      onSuccess: () => form.reset(),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "invalid") setErrors(err.fieldErrors());
        else if (err instanceof ApiError && err.code === "host_taken") setErrors({ host: "Another app already uses this host." });
        else toast.error("Could not add the domain. Try again.");
      },
    });
  }

  function onVerify(d: Domain) {
    verify.mutate(d.id, {
      onSuccess: (updated) => {
        if (updated.status === "active") toast.success(`${updated.host} is active.`);
        else toast.message("The TXT record does not match yet. Try again after DNS updates.");
      },
    });
  }

  function confirmRemove() {
    if (!pendingRemove) return;
    const host = pendingRemove.host;
    remove.mutate(pendingRemove.id, {
      onSuccess: () => {
        setPendingRemove(null);
        toast.success(`Removed ${host}.`);
      },
    });
  }

  return (
    <section aria-labelledby="domains-heading" className="flex flex-col gap-4">
      <header>
        <h2 id="domains-heading" className="text-sm font-semibold">
          Domains
        </h2>
        <p className="text-sm text-muted">Serve this app on your own host names. HTTPS certificates are issued automatically.</p>
      </header>

      {domains.isError ? (
        <QueryError error={domains.error} onRetry={() => void domains.refetch()} notFoundTitle="App not found" />
      ) : domains.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : domains.data.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="No custom domains"
          description="Add a host name to point your own domain at this app."
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {domains.data.map((d) => (
            <li key={d.id} className="flex flex-col gap-3 rounded-[10px] border border-line bg-surface p-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-mono text-sm font-medium">{d.host}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={d.status === "failed" ? "danger" : d.status === "active" ? "success" : "outline"}>
                    {STATUS_LABEL[d.status]}
                  </Badge>
                  <Badge variant={d.cert_status === "error" ? "danger" : "outline"}>
                    {CERT_LABEL[d.cert_status]}
                  </Badge>
                </div>
              </div>

              {d.cert_status === "issued" && d.cert_not_after ? (
                <p className="text-sm text-muted">Expires {new Date(d.cert_not_after).toLocaleDateString()}.</p>
              ) : null}
              {d.cert_status === "error" && d.cert_error ? (
                <p className="text-sm text-danger">{d.cert_error}</p>
              ) : null}
              {d.status === "failed" ? (
                <p className="text-sm text-danger">The TXT record was missing, so the domain is inactive. Restore it and verify again.</p>
              ) : null}

              {d.status === "pending" ? <DnsRecord host={d.host} domain={d} /> : null}

              <p className="text-sm text-muted">Keep the TXT record; removing it deactivates the domain.</p>

              {canWrite ? (
              <div className="flex flex-wrap gap-2">
                {d.status !== "active" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Verify ${d.host}`}
                    disabled={verify.isPending}
                    onClick={() => onVerify(d)}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    Verify
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={`Remove ${d.host}`}
                  onClick={() => setPendingRemove(d)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Remove
                </Button>
              </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <FormField label="Domain" name="host" autoComplete="off" spellCheck={false} placeholder="www.example.com" error={errors.host} />
        <div>
          <Button type="submit" disabled={add.isPending}>
            Add domain
          </Button>
        </div>
      </AuthForm>
      ) : null}

      <Dialog open={pendingRemove !== null} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove {pendingRemove?.host}?</DialogTitle>
            <DialogDescription>Requests to this host stop working right away.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRemove(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRemove} disabled={remove.isPending}>
              Remove domain
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
