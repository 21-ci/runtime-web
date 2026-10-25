import { useId, useState, type FormEvent } from "react";
import { Copy, MailPlus, X } from "lucide-react";
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
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { OrgRole } from "@/lib/types";

import { ROLE_KEY, assignableRoles } from "../members/roles";
import { useCreateInvite, useInvites, useRevokeInvite, type Invite } from "./hooks";

// InvitesPanel lists pending invites and creates new ones. The invite link is shown once.
export function InvitesPanel({ org, role }: { org: string; role: OrgRole }) {
  const { t } = useTranslation(["invites", "common", "members"]);
  const canManage = role === "owner" || role === "admin";
  const invites = useInvites(org, canManage);
  const [pendingRevoke, setPendingRevoke] = useState<Invite | null>(null);
  const revoke = useRevokeInvite(org);

  if (!canManage) return null;

  function confirmRevoke() {
    if (!pendingRevoke) return;
    const email = pendingRevoke.email;
    revoke.mutate(pendingRevoke.id, {
      onSuccess: () => {
        setPendingRevoke(null);
        toast.success(t("toast.revoked", { email }));
      },
    });
  }

  return (
    <section aria-labelledby="invites-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header>
        <h2 id="invites-heading" className="text-[15px] font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted">{t("description")}</p>
      </header>

      {invites.isError ? (
        <QueryError error={invites.error} onRetry={() => void invites.refetch()} notFoundTitle={t("orgNotFound")} />
      ) : invites.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : invites.data.length === 0 ? (
        <EmptyState entity="invites" icon={MailPlus} title={t("empty.title")} description={t("empty.description")} />
      ) : (
        <ul aria-label={t("listAria")} className="divide-y divide-line rounded-lg border border-line bg-surface shadow-card">
          {invites.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span>
                <span className="font-medium">{inv.email}</span>
                <span className="ml-2 text-muted">
                  {t("item.meta", {
                    role: inv.role ? t(ROLE_KEY[inv.role]) : t("item.noRole"),
                    date: formatDate(inv.expires_at),
                  })}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t("revoke.label", { email: inv.email })}
                onClick={() => setPendingRevoke(inv)}
              >
                <X className="size-4" aria-hidden />
                {t("revoke.button")}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <InviteForm org={org} role={role} />

      <Dialog open={pendingRevoke !== null} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("revoke.title")}</DialogTitle>
            <DialogDescription>{t("revoke.description", { email: pendingRevoke?.email ?? "" })}</DialogDescription>
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

function InviteForm({ org, role }: { org: string; role: OrgRole }) {
  const { t } = useTranslation(["invites", "common", "members"]);
  const create = useCreateInvite(org);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const roleId = useId();
  const roles = assignableRoles(role);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const email = String(data.get("email") ?? "").trim();
    const picked = String(data.get("role") ?? "member") as OrgRole;
    if (!email.includes("@")) {
      setErrors({ email: t("errors.email") });
      return;
    }
    setErrors({});
    create.mutate(
      { email, role: picked },
      {
        onSuccess: (res) => {
          setLink(res.link);
          form.reset();
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid") setErrors(err.fieldErrors());
          else toast.error(t("toast.createFailed"));
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <FormField label={t("common:email")} name="email" type="email" autoComplete="off" error={errors.email} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={roleId}>{t("common:role")}</Label>
          <Select name="role" defaultValue="member">
            <SelectTrigger id={roleId}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {t(ROLE_KEY[r])}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Button type="submit" variant="default" disabled={create.isPending}>
            {t("form.submit")}
          </Button>
        </div>
      </AuthForm>
      {link ? (
        <div className="flex items-center gap-2 rounded-lg border border-line bg-panel p-3 text-sm">
          <code className="min-w-0 flex-1 break-all font-mono">{link}</code>
          <Button variant="secondary" size="sm" aria-label={t("form.copyLinkAria")} onClick={() => void navigator.clipboard.writeText(link)}>
            <Copy className="size-4" aria-hidden />
            {t("common:copy")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLink(null)}>
            {t("common:done")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
