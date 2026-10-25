import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useBranding } from "@/components/features/branding/hooks";
import { ApiError } from "@/lib/api";
import { useAuthProviders, useLogin } from "@/hooks/auth";
import { safeNext } from "@/lib/safe-next";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

// OAuth callback failures arrive as /login?error=<code>; each known code has a message in `auth`.
const OAUTH_ERRORS = [
  "oauth_state_invalid",
  "email_unverified",
  "no_account",
  "account_disabled",
  "oauth_failed",
  "link_required",
] as const;

function isOAuthError(code: string): code is (typeof OAUTH_ERRORS)[number] {
  return (OAUTH_ERRORS as readonly string[]).includes(code);
}

type LoginSearch = { next?: string; error?: string };

export const Route = createFileRoute("/login/")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    next: typeof search.next === "string" ? search.next : undefined,
    error: typeof search.error === "string" ? search.error : undefined,
  }),
  component: LoginPage,
});

function loginMessage(err: ApiError, t: TFunction<["auth", "common"]>): string {
  if (err.code === "invalid_credentials") return t("login.invalidCredentials");
  if (err.code === "rate_limited") {
    return err.retryAfter !== undefined
      ? t("tooManyAttemptsWait", { seconds: err.retryAfter })
      : t("tooManyAttempts");
  }
  return t("common:somethingWrong");
}

function LoginPage() {
  const { data: brand } = useBranding();
  const search = Route.useSearch();
  const next = safeNext(search.next);
  const navigate = useNavigate();
  const providers = useAuthProviders();
  const login = useLogin();
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const { t } = useTranslation(["auth", "common"]);

  const passwordDisabled = providers.data?.password_login_disabled ?? false;
  const passwordVisible = !passwordDisabled || showPassword;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const email = String(form.get("email") ?? "").trim();
    const password = String(form.get("password") ?? "");
    const fieldErrs: Record<string, string> = {};
    if (!email) fieldErrs.email = t("login.enterEmail");
    if (!password) fieldErrs.password = t("login.enterPassword");
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

  const formError = login.error instanceof ApiError ? loginMessage(login.error, t) : null;

  return (
    <AuthShell
      title={brand?.login_headline || t("login.title")}
      description={
        brand?.login_subtitle ||
        (brand?.product_name ? t("login.subtitleProduct", { product: brand.product_name }) : t("login.subtitle"))
      }
    >
      {search.error ? (
        <p role="alert" className="mb-4 text-sm text-danger">
          {isOAuthError(search.error) ? t(`oauthErrors.${search.error}`) : t("oauthErrors.oauth_failed")}
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
                {t("login.continueWith", { provider: p.name })}
              </a>
            </Button>
          ))}
        </div>
      ) : null}

      {passwordVisible && providers.data ? (
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField
            label={t("email")}
            name="email"
            type="email"
            autoComplete="username"
            error={errors.email}
          />
          <FormField
            label={t("password")}
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
            {login.isPending ? t("login.submitting") : t("login.submit")}
          </Button>
        </AuthForm>
      ) : null}

      {passwordDisabled && !showPassword ? (
        <Button variant="ghost" className="w-full" onClick={() => setShowPassword(true)}>
          {t("login.withPassword")}
        </Button>
      ) : null}

    </AuthShell>
  );
}
