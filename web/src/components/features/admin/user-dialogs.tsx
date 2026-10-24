import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ApiError } from "@/lib/api";
import type { OrgRole } from "@/lib/types";

import { errorMessage, useAdminOrgs, useCreateAdminInvite, useCreateAdminUser } from "./admin-api";
import { SecretOnce } from "./secret-once";

// NONE_VALUE is the "no selection" choice in a SelectField. Radix Select items cannot be empty strings.
export const NONE_VALUE = "__none__";

// CreateUserDialog creates an account with a temporary password. The password is shown once in the
// same dialog; closing the dialog discards it.
export function CreateUserDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [created, setCreated] = useState<{ email: string; temp_password: string } | null>(null);
  const create = useCreateAdminUser();

  function close(next: boolean) {
    if (!next) {
      setErrors({});
      setCreated(null);
      create.reset();
    }
    onOpenChange(next);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const next: Record<string, string> = {};
    if (!email) next.email = "Enter an email address.";
    if (!name) next.name = "Enter a name.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    create.mutate(
      { email, name, instance_admin: form.get("instance_admin") === "on" },
      {
        onSuccess: (res) => setCreated({ email: res.user.email, temp_password: res.temp_password }),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "email_taken") {
            setErrors({ email: "An account with this email already exists." });
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
          <DialogTitle>New user</DialogTitle>
          <DialogDescription>
            The user signs in with a temporary password and must change it at first sign-in.
          </DialogDescription>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <SecretOnce
              label="Temporary password"
              value={created.temp_password}
              note={`Share it with ${created.email} now. It is shown once and cannot be retrieved later.`}
            />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <AuthForm errors={errors} onSubmit={onSubmit}>
            <FormField label="Email" name="email" type="email" autoComplete="off" error={errors.email} />
            <FormField label="Name" name="name" autoComplete="off" error={errors.name} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="instance_admin" className="size-4 accent-accent" />
              Instance admin
            </label>
            <DialogFooter>
              <Button type="submit" variant="default" disabled={create.isPending}>
                Create user
              </Button>
            </DialogFooter>
          </AuthForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

// InviteDialog creates a single-use invite link, optionally bound to an org and role. The link is
// shown once; the invites list keeps the pending record for revocation.
export function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [link, setLink] = useState<string | null>(null);
  const orgs = useAdminOrgs();
  const create = useCreateAdminInvite();

  function close(next: boolean) {
    if (!next) {
      setErrors({});
      setLink(null);
      create.reset();
    }
    onOpenChange(next);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const org = String(form.get("org") ?? "") === NONE_VALUE ? "" : String(form.get("org") ?? "");
    const role = String(form.get("role") ?? "member") as OrgRole;
    if (!email) {
      setErrors({ email: "Enter an email address." });
      return;
    }
    setErrors({});
    create.mutate(org ? { email, org, role } : { email }, {
      onSuccess: (res) => setLink(res.link),
      onError: (err) => {
        const fields = err instanceof ApiError ? err.fieldErrors() : {};
        if (Object.keys(fields).length > 0) setErrors(fields);
        else toast.error(errorMessage(err));
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite link</DialogTitle>
          <DialogDescription>Creates a single-use link that expires in 7 days.</DialogDescription>
        </DialogHeader>
        {link ? (
          <div className="flex flex-col gap-4">
            <SecretOnce
              label="Invite link"
              value={link}
              note="Shown once. Copy it now, it cannot be shown again. Revoke the invite if it leaks."
            />
            <DialogFooter>
              <Button onClick={() => close(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <AuthForm errors={errors} onSubmit={onSubmit}>
            <FormField label="Email" name="email" type="email" autoComplete="off" error={errors.email} />
            <SelectField
              label="Organization (optional)"
              name="org"
              error={errors.org}
              defaultValue={NONE_VALUE}
              options={[
                { value: NONE_VALUE, label: "No organization" },
                ...(orgs.data ?? []).map((o) => ({ value: o.slug, label: `${o.name} (${o.slug})` })),
              ]}
            />
            <SelectField
              label="Role in organization"
              name="role"
              error={errors.role}
              defaultValue="member"
              options={[
                { value: "member", label: "Member" },
                { value: "admin", label: "Admin" },
                { value: "owner", label: "Owner" },
              ]}
            />
            <DialogFooter>
              <Button type="submit" variant="default" disabled={create.isPending}>
                Create invite link
              </Button>
            </DialogFooter>
          </AuthForm>
        )}
      </DialogContent>
    </Dialog>
  );
}

// SecretDialog shows a one-time value from a follow-up action (a reset password). It closes with
// Done and keeps nothing afterwards.
export function SecretDialog({
  open,
  onClose,
  title,
  label,
  value,
  note,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  label: string;
  value: string;
  note: string;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <SecretOnce label={label} value={value} note={note} />
        {children}
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// SelectField is a labelled Radix Select that submits its value with the surrounding form.
function SelectField({
  label,
  name,
  error,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  error?: string;
  options: { value: string; label: string }[];
  defaultValue?: string;
}) {
  const id = `field-${name}`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select name={name} defaultValue={defaultValue}>
        <SelectTrigger id={id} aria-invalid={error ? true : undefined} className="h-[38px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </div>
  );
}

export { SelectField };
