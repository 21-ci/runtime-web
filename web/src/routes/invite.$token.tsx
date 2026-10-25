import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useAcceptInvite, useInvite } from "@/hooks/auth";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

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
  const qc = useQueryClient();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [needsLogin, setNeedsLogin] = useState(false);
  const { t } = useTranslation(["auth", "common"]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get("name") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fieldErrs: Record<string, string> = {};
    if (!name) fieldErrs.name = t("invite.enterName");
    if (password.length < 12) fieldErrs.password = t("passwordTooShort", { count: 12 });
    setErrors(fieldErrs);
    setFormError(null);
    if (Object.keys(fieldErrs).length > 0) return;

    accept.mutate(
      { name, password },
      {
        onSuccess: () => {
          // The accept call starts a session. Drop cached data from any earlier user, then load the
          // session (GET /api/me) and go to the org home instead of the sign-in page.
          qc.removeQueries();
          void navigate({ to: "/", replace: true });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) return setFormError(t("common:somethingWrong"));
          if (err.code === "invite_login_required") return setNeedsLogin(true);
          if (err.code === "invite_invalid") return setFormError(t("invite.invalidShort"));
          if (err.status === 422) return setErrors(err.fieldErrors());
          setFormError(errorMessage(err));
        },
      },
    );
  }

  if (invite.isPending) {
    return (
      <AuthShell title={t("invite.title")} description={t("invite.description")}>
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      </AuthShell>
    );
  }

  if (invite.isError || !invite.data) {
    return (
      <AuthShell title={t("invite.invalidTitle")}>
        <p className="text-sm text-muted">{t("invite.invalidBody")}</p>
        <p className="mt-4 text-sm">
          <Link to="/login" search={{}} className="underline">
            {t("goToSignIn")}
          </Link>
        </p>
      </AuthShell>
    );
  }

  const { email, org_name } = invite.data;

  return (
    <AuthShell title={t("invite.title")} description={t("invite.description")}>
      <div className="mb-4 text-sm">
        <p className="text-muted">{t("email")}</p>
        <p className="font-medium">{email}</p>
        {org_name ? <p className="mt-2 text-muted">{t("invite.joining", { org: org_name })}</p> : null}
      </div>

      {needsLogin ? (
        <div role="alert" className="flex flex-col gap-3 text-sm">
          <p>{t("invite.existingAccount")}</p>
          <Button asChild>
            <Link to="/login" search={{ next: `/invite/${token}` }}>
              {t("invite.signInToAccept")}
            </Link>
          </Button>
        </div>
      ) : (
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label={t("name")} name="name" autoComplete="name" error={errors.name} />
          <FormField
            label={t("password")}
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
            {accept.isPending ? t("invite.submitting") : t("invite.submit")}
          </Button>
        </AuthForm>
      )}
    </AuthShell>
  );
}
