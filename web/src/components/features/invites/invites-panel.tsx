import { useId, useState, type FormEvent } from "react";
import { Copy, MailPlus, X } from "lucide-react";
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
import { ApiError } from "@/lib/api";
import type { OrgRole } from "@/lib/types";

import { ROLE_LABEL, assignableRoles } from "../members/roles";
import { useCreateInvite, useInvites, useRevokeInvite, type Invite } from "./hooks";

// InvitesPanel lists pending invites and creates new ones. The invite link is shown once.
export function InvitesPanel({ org, role }: { org: string; role: OrgRole }) {
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
        toast.success(`Revoked the invite for ${email}.`);
      },
    });
  }

  return (
    <section aria-labelledby="invites-heading" className="flex flex-col gap-4">
      <header>
        <h2 id="invites-heading" className="text-sm font-semibold">
          Pending invites
        </h2>
        <p className="text-sm text-muted">Invites expire after 7 days. Revoke one to stop its link from working.</p>
      </header>

      {invites.isError ? (
        <QueryError error={invites.error} onRetry={() => void invites.refetch()} notFoundTitle="Org not found" />
      ) : invites.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : invites.data.length === 0 ? (
        <EmptyState icon={MailPlus} title="No pending invites" description="Invite a teammate with the form below." />
      ) : (
        <ul aria-label="Pending invites" className="divide-y divide-line rounded-[10px] border border-line bg-surface">
          {invites.data.map((inv) => (
            <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm">
              <span>
                <span className="font-medium">{inv.email}</span>
                <span className="ml-2 text-muted">
                  {inv.role ? ROLE_LABEL[inv.role] : "No role"} · expires {new Date(inv.expires_at).toLocaleDateString()}
                </span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Revoke invite for ${inv.email}`}
                onClick={() => setPendingRevoke(inv)}
              >
                <X className="size-4" aria-hidden />
                Revoke invite
              </Button>
            </li>
          ))}
        </ul>
      )}

      <InviteForm org={org} role={role} />

      <Dialog open={pendingRevoke !== null} onOpenChange={(open) => !open && setPendingRevoke(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke this invite?</DialogTitle>
            <DialogDescription>{pendingRevoke?.email} will need a new invite to join.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPendingRevoke(null)}>
              Cancel
            </Button>
            <Button variant="danger" onClick={confirmRevoke} disabled={revoke.isPending}>
              Revoke
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function InviteForm({ org, role }: { org: string; role: OrgRole }) {
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
      setErrors({ email: "Enter an email address." });
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
          else toast.error("Could not send the invite. Try again.");
        },
      },
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <FormField label="Email" name="email" type="email" autoComplete="off" error={errors.email} />
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={roleId}>Role</Label>
          <select id={roleId} name="role" defaultValue="member" className="h-[34px] rounded-[8px] border border-line bg-surface px-2 text-sm">
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <Button type="submit" disabled={create.isPending}>
            Create invite
          </Button>
        </div>
      </AuthForm>
      {link ? (
        <div className="flex items-center gap-2 rounded-[8px] border border-line bg-panel p-3 text-sm">
          <code className="min-w-0 flex-1 break-all font-mono">{link}</code>
          <Button variant="secondary" size="sm" aria-label="Copy invite link" onClick={() => void navigator.clipboard.writeText(link)}>
            <Copy className="size-4" aria-hidden />
            Copy
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setLink(null)}>
            Done
          </Button>
        </div>
      ) : null}
    </div>
  );
}
