import { useState, type FormEvent } from "react";
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

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!code) {
      setFieldError({ code: recovery ? "Enter a recovery code." : "Enter the 6-digit code." });
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
            setError("Too many attempts. Wait and try again.");
          } else if (err instanceof ApiError && err.code === "invalid_code") {
            setError("That code is not right. Try again.");
          } else if (err instanceof ApiError && err.code === "unauthenticated") {
            setError("Your sign-in expired. Start again.");
          } else {
            setError("Something went wrong. Try again.");
          }
        },
      },
    );
  }

  return (
    <AuthShell title="Two-step verification">
      <p className="mb-4 text-sm text-muted">
        {recovery
          ? "Enter one of your recovery codes. Each code works once."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      <AuthForm errors={fieldError} onSubmit={onSubmit}>
        <FormField
          label={recovery ? "Recovery code" : "Authentication code"}
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
          {mfa.isPending ? "Verifying…" : "Verify"}
        </Button>
      </AuthForm>
      <div className="mt-4 flex flex-col items-center gap-2 text-sm">
        <Button variant="ghost" onClick={() => setRecovery((r) => !r)}>
          {recovery ? "Use an authenticator code" : "Use a recovery code"}
        </Button>
        <Link to="/login" search={{}} className="text-muted underline">
          Back to sign in
        </Link>
      </div>
    </AuthShell>
  );
}
