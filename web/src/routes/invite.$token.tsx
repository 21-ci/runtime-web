import { useState, type FormEvent } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useAcceptInvite, useInvite } from "@/hooks/auth";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/invite/$token")({
  component: InvitePage,
});

// InvitePage accepts a single-use invite link. A new user sets a name and password here; the
// account must sign in afterwards. An existing account has to be signed in as that user first.
function InvitePage() {
  const { token } = Route.useParams();
  const invite = useInvite(token);
  const accept = useAcceptInvite(token);
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fieldErrs: Record<string, string> = {};
    if (!name) fieldErrs.name = "Enter your name.";
    if (password.length < 12) fieldErrs.password = "Use at least 12 characters.";
    setErrors(fieldErrs);
    setFormError(null);
    if (Object.keys(fieldErrs).length > 0) return;

    accept.mutate(
      { name, password },
      {
        onSuccess: () => {
          void navigate({ to: "/login", search: {} });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) return setFormError("Something went wrong. Try again.");
          if (err.code === "invite_login_required") return setNeedsLogin(true);
          if (err.code === "invite_invalid") return setFormError("This invite is expired, used or revoked.");
          if (err.status === 422) return setErrors(err.fieldErrors());
          setFormError(err.message);
        },
      },
    );
  }

  if (invite.isPending) {
    return (
      <AuthShell title="Accept invite" description="You have been invited to join a team on Runtime.">
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </AuthShell>
    );
  }

  if (invite.isError || !invite.data) {
    return (
      <AuthShell title="Invite not valid">
        <p className="text-sm text-muted">This invite link is expired, used or revoked. Ask an admin for a new one.</p>
        <p className="mt-4 text-sm">
          <Link to="/login" search={{}} className="underline">
            Go to sign in
          </Link>
        </p>
      </AuthShell>
    );
  }

  const { email, org_name } = invite.data;

  return (
    <AuthShell title="Accept invite" description="You have been invited to join a team on Runtime.">
      <div className="mb-4 text-sm">
        <p className="text-muted">Email</p>
        <p className="font-medium">{email}</p>
        {org_name ? <p className="mt-2 text-muted">Joining {org_name}</p> : null}
      </div>

      {needsLogin ? (
        <div role="alert" className="flex flex-col gap-3 text-sm">
          <p>This invite is for an account that already exists. Sign in as that account to accept.</p>
          <Button asChild>
            <Link to="/login" search={{ next: `/invite/${token}` }}>
              Sign in to accept
            </Link>
          </Button>
        </div>
      ) : (
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label="Name" name="name" autoComplete="name" error={errors.name} />
          <FormField
            label="Password"
            name="password"
            type="password"
            autoComplete="new-password"
            error={errors.password}
          />
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
          <Button type="submit" variant="default" disabled={accept.isPending}>
            {accept.isPending ? "Accepting…" : "Accept invite"}
          </Button>
        </AuthForm>
      )}
    </AuthShell>
  );
}
