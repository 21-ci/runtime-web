import { useState, type FormEvent } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Globe, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Trans, useTranslation } from "react-i18next";

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
import { formatDate } from "@/lib/format";

// Shape from docs/reference/api.md §8.5.
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

const STATUS_KEY = {
  pending: "status.pending",
  active: "status.active",
  failed: "status.failed",
} as const;

const CERT_KEY = {
  none: "cert.none",
  pending: "cert.pending",
  issued: "cert.issued",
  error: "cert.error",
} as const;

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
  const { t } = useTranslation("domains");
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(
          () => toast.success(t("copy.done")),
          () => toast.error(t("copy.failed")),
        );
      }}
    >
      <Copy className="size-4" aria-hidden />
      <span className="sr-only">{label}</span>
    </Button>
  );
}

function DnsRecord({ host, domain }: { host: string; domain: Domain }) {
  const { t } = useTranslation("domains");
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-3 text-sm">
      <p>
        <Trans
          ns="domains"
          i18nKey="dns.intro"
          values={{ host }}
          components={{ host: <span className="break-all font-mono" /> }}
        />
      </p>
      <dl className="grid gap-2">
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t("dns.txtName")}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.txt_name}</code>
            <CopyButton label={t("copy.txtName")} value={domain.txt_name} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t("dns.txtValue")}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.txt_value}</code>
            <CopyButton label={t("copy.txtValue")} value={domain.txt_value} />
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt className="text-muted">{t("dns.cnameTarget")}</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <code className="truncate font-mono">{domain.cname_target}</code>
            <CopyButton label={t("copy.cnameTarget")} value={domain.cname_target} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

// DomainsPanel manages custom hosts for one app: DNS instructions, status and certificate state.
// canWrite false (role lacks domains.manage) shows hosts and status only.
export function DomainsPanel({ org, app, canWrite = true }: { org: string; app: string; canWrite?: boolean }) {
  const { t } = useTranslation(["domains", "common"]);
  const domains = useDomains(org, app);
  const { add, verify, remove } = useDomainMutations(org, app);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pendingRemove, setPendingRemove] = useState<Domain | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const host = String(new FormData(form).get("host") ?? "").trim();
    if (host === "") {
      setErrors({ host: t("form.empty") });
      return;
    }
    setErrors({});
    add.mutate(host, {
      onSuccess: () => form.reset(),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "invalid") setErrors(err.fieldErrors());
        else if (err instanceof ApiError && err.code === "host_taken") setErrors({ host: t("form.taken") });
        else toast.error(t("form.failed"));
      },
    });
  }

  function onVerify(d: Domain) {
    verify.mutate(d.id, {
      onSuccess: (updated) => {
        if (updated.status === "active") toast.success(t("verify.active", { host: updated.host }));
        else toast.message(t("verify.mismatch"));
      },
    });
  }

  function confirmRemove() {
    if (!pendingRemove) return;
    const host = pendingRemove.host;
    remove.mutate(pendingRemove.id, {
      onSuccess: () => {
        setPendingRemove(null);
        toast.success(t("remove.done", { host }));
      },
    });
  }

  return (
    <section aria-labelledby="domains-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header>
        <h2 id="domains-heading" className="text-[15px] font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted">{t("description")}</p>
      </header>

      {domains.isError ? (
        <QueryError error={domains.error} onRetry={() => void domains.refetch()} notFoundTitle={t("notFound")} />
      ) : domains.isPending ? (
        <Skeleton className="h-32 w-full" />
      ) : domains.data.length === 0 ? (
        <EmptyState bare entity="domains"
          icon={Globe}
          title={t("empty.title")}
          description={t("empty.description")}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {domains.data.map((d) => (
            <li key={d.id} className="group flex flex-col gap-3 rounded-lg border border-line bg-surface p-4">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono text-sm font-medium">{d.host}</span>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge dot variant={d.status === "failed" ? "danger" : d.status === "active" ? "success" : "warning"}>
                    {t(STATUS_KEY[d.status])}
                  </Badge>
                  <Badge variant={d.cert_status === "error" ? "danger" : "outline"}>
                    {t(CERT_KEY[d.cert_status])}
                  </Badge>
                </div>
              </div>

              {d.cert_status === "issued" && d.cert_not_after ? (
                <p className="text-sm text-muted">{t("cert.expires", { date: formatDate(d.cert_not_after) })}</p>
              ) : null}
              {d.cert_status === "error" && d.cert_error ? (
                <p className="text-sm text-danger">{d.cert_error}</p>
              ) : null}
              {d.status === "failed" ? (
                <p className="text-sm text-danger">{t("failedHint")}</p>
              ) : null}

              {d.status === "pending" ? <DnsRecord host={d.host} domain={d} /> : null}

              <p className="text-sm text-muted">{t("keepTxt")}</p>

              {canWrite ? (
              <div className="flex flex-wrap gap-2 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100">
                {d.status !== "active" ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={t("verify.label", { host: d.host })}
                    disabled={verify.isPending}
                    onClick={() => onVerify(d)}
                  >
                    <RefreshCw className="size-4" aria-hidden />
                    {t("verify.button")}
                  </Button>
                ) : null}
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label={t("remove.label", { host: d.host })}
                  onClick={() => setPendingRemove(d)}
                >
                  <Trash2 className="size-4" aria-hidden />
                  {t("remove.button")}
                </Button>
              </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {canWrite ? (
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <FormField label={t("form.label")} name="host" autoComplete="off" spellCheck={false} placeholder={t("form.placeholder")} error={errors.host} />
        <div>
          <Button type="submit" variant="default" disabled={add.isPending}>
            {t("form.add")}
          </Button>
        </div>
      </AuthForm>
      ) : null}

      <Dialog open={pendingRemove !== null} onOpenChange={(open) => !open && setPendingRemove(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("remove.title", { host: pendingRemove?.host })}</DialogTitle>
            <DialogDescription>{t("remove.description")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRemove(null)}>
              {t("common:cancel")}
            </Button>
            <Button variant="danger-solid" onClick={confirmRemove} disabled={remove.isPending}>
              {t("remove.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
