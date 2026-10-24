import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { ApiError } from "@/lib/api";
import { useAuthProviders, useLogin } from "@/hooks/auth";
import { safeNext } from "@/lib/safe-next";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

const OAUTH_ERRORS: Record<string, string> = {
  oauth_state_invalid: "The sign-in link expired. Try again.",
  email_unverified: "Your email is not verified with that provider.",
  no_account: "No account uses that email. Ask an admin for an invite.",
  account_disabled: "This account is disabled. Contact an admin.",
  oauth_failed: "Sign-in failed. Try again.",
};

type LoginSearch = { next?: string; error?: string };

export const Route = createFileRoute("/login/")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: typeof search.next === "string" ? search.next : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: LoginPage,
});

function loginMessage(err: ApiError): string {
  if (err.code === "invalid_credentials") return "Email or password is wrong.";
  if (err.code === "rate_limited") {
    return err.retryAfter !== undefined
      ? `Too many attempts. Wait ${err.retryAfter} s and try again.`
      : "Too many attempts. Wait and try again.";
  }
  return "Something went wrong. Try again.";
}

function LoginPage() {
  const search = Route.useSearch();
  const next = safeNext(search.next);
  const navigate = useNavigate();
  const providers = useAuthProviders();
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const passwordDisabled = providers.data?.password_login_disabled ?? false;
  const passwordVisible = !passwordDisabled || showPassword;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fieldErrs: Record<string, string> = {};
    if (!email) fieldErrs.email = "Enter your email.";
    if (!password) fieldErrs.password = "Enter your password.";
    setErrors(fieldErrs);
    if (Object.keys(fieldErrs).length > 0) return;

    login.mutate(
      { email, password },
      {
        onSuccess: (data) => {
          if (data.mfa_required) {
            void navigate({ to: "/login/mfa", search: { next } });
          } else if (data.user.must_change_password) {
            void navigate({ to: "/change-password" });
          } else {
            void navigate({ href: next });
          }
        },
      },
    );
  }

  const formError = login.error instanceof ApiError ? loginMessage(login.error) : null;

  return (
    <AuthShell title="Welcome back" description="Sign in to your Runtime workspace to pick up where you left off.">
      {search.error ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {OAUTH_ERRORS[search.error] ?? "Sign-in failed. Try again."}
        </p>
      ) : null}

      {providers.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : null}

      {providers.data && providers.data.providers.length > 0 ? (
        <div className="mb-4 flex flex-col gap-2">
          {providers.data.providers.map((p) => (
            <Button key={p.id} asChild variant="secondary" className="w-full">
              <a href={`/api/auth/oauth/${p.id}/start?next=${encodeURIComponent(next)}`}>
                Continue with {p.name}
              </a>
            </Button>
          ))}
        </div>
      ) : null}

      {passwordVisible && providers.data ? (
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField
            label="Email"
            name="email"
            type="email"
            autoComplete="username"
            error={errors.email}
          />
          <FormField
            label="Password"
            name="password"
            type="password"
            autoComplete="current-password"
            error={errors.password}
          />
          {formError ? (
            <p role="alert" className="text-sm text-danger">
              {formError}
            </p>
          ) : null}
          <Button type="submit" variant="default" disabled={login.isPending}>
            {login.isPending ? "Signing in…" : "Sign in"}
          </Button>
        </AuthForm>
      ) : null}

      {passwordDisabled && !showPassword ? (
        <Button variant="ghost" className="w-full" onClick={() => setShowPassword(true)}>
          Sign in with password
        </Button>
      ) : null}

    </AuthShell>
  );
}
