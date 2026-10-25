import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useMfa } from "@/hooks/auth";
import { ApiError } from "@/lib/api";
import { safeNext } from "@/lib/safe-next";

export const Route = createFileRoute("/login/mfa")({
  validateSearch: (search: Record<string, unknown>): { next?: string } => ({
    next: typeof search.next === "string" ? search.next : undefined,
  }),
  component: MfaPage,
});

function MfaPage() {
  const next = safeNext(Route.useSearch().next);
  const navigate = useNavigate();
  const mfa = useMfa();
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  const { t } = useTranslation(["auth", "common"]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!code) {
      setFieldError({ code: recovery ? t("mfa.enterRecovery") : t("mfa.enterCode") });
      return;
    }
    setFieldError({});
    setError(null);
    mfa.mutate(
      { code },
      {
        onSuccess: (data) => {
          if (data.user.must_change_password) {
            void navigate({ to: "/change-password" });
          } else {
            void navigate({ href: next });
          }
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "rate_limited") {
            setError(t("tooManyAttempts"));
          } else if (err instanceof ApiError && err.code === "invalid_code") {
            setError(t("mfa.invalidCode"));
          } else if (err instanceof ApiError && err.code === "unauthenticated") {
            setError(t("mfa.expired"));
          } else {
            setError(t("common:somethingWrong"));
          }
        },
      },
    );
  }

  return (
    <AuthShell title={t("mfa.title")} description={t("mfa.description")}>
      <p className="mb-4 text-sm text-muted">
        {recovery ? t("mfa.recoveryHint") : t("mfa.codeHint")}
      </p>
      <AuthForm errors={fieldError} onSubmit={onSubmit}>
        <FormField
          label={recovery ? t("mfa.recoveryLabel") : t("mfa.codeLabel")}
          name="code"
          inputMode={recovery ? "text" : "numeric"}
          autoComplete="one-time-code"
          autoCapitalize="off"
          spellCheck={false}
          error={fieldError.code}
        />
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <Button type="submit" variant="default" disabled={mfa.isPending}>
          {mfa.isPending ? t("mfa.submitting") : t("mfa.submit")}
        </Button>
      </AuthForm>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        <Button variant="ghost" onClick={() => setRecovery((r) => !r)}>
          {recovery ? t("mfa.useCode") : t("mfa.useRecovery")}
        </Button>
        <Link to="/login" search={{}} className="text-muted underline">
          {t("backToSignIn")}
        </Link>
      </div>
    </AuthShell>
  );
}
