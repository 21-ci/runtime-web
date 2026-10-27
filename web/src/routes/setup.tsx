import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useBranding } from "@/components/features/branding/hooks";
import { useSetup, useSetupStatus } from "@/hooks/auth";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});

// SetupPage creates the first instance admin. It only shows while GET /api/setup says needed,
// and it always requires the setup token (RTWEB_SETUP_TOKEN or the one logged at startup).
function SetupPage() {
  const { data: brand } = useBranding();
  const status = useSetupStatus();
  const setup = useSetup();
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const { t } = useTranslation(["auth", "common"]);

  if (status.data && !status.data.needed) return <Navigate to="/login" search={{}} />;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const values = {
      setup_token: String(form.get("setup_token") ?? "").trim(),
      email: String(form.get("email") ?? "").trim(),
      name: String(form.get("name") ?? "").trim(),
      password: String(form.get("password") ?? ""),
    };
    const fieldErrs: Record<string, string> = {};
    if (!values.setup_token) fieldErrs.setup_token = t("setup.enterToken");
    if (!values.email) fieldErrs.email = t("setup.enterEmail");
    if (!values.name) fieldErrs.name = t("setup.enterName");
    if (values.password.length < 12) fieldErrs.password = t("passwordTooShort", { count: 12 });
    setErrors(fieldErrs);
    setFormError(null);
    if (Object.keys(fieldErrs).length > 0) return;

    setup.mutate(values, {
      onSuccess: () => {
        void navigate({ to: "/" });
      },
      onError: (err) => {
        if (!(err instanceof ApiError)) return setFormError(t("common:somethingWrong"));
        if (err.code === "setup_token_invalid") return setErrors({ setup_token: t("setup.tokenInvalid") });
        if (err.code === "already_set_up") return void navigate({ to: "/login", search: {} });
        if (err.status === 422) return setErrors(err.fieldErrors());
        setFormError(errorMessage(err));
      },
    });
  }

  return (
    <AuthShell title={t("setup.title", { product: brand?.product_name || "Runtime" })} description={t("setup.description")}>
      {status.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            {t("setup.intro")}
          </p>
          <AuthForm errors={errors} onSubmit={onSubmit}>
            <FormField
              label={t("setup.tokenLabel")}
              name="setup_token"
              type="password"
              autoComplete="off"
              hint={t("setup.tokenHint")}
              error={errors.setup_token}
            />
            <FormField label={t("email")} name="email" type="email" autoComplete="username" error={errors.email} />
            <FormField label={t("name")} name="name" autoComplete="name" error={errors.name} />
            <FormField
              label={t("password")}
              name="password"
              type="password"
              autoComplete="new-password"
              hint={t("passwordHint", { count: 12 })}
              error={errors.password}
            />
            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <Button type="submit" variant="default" disabled={setup.isPending}>
              {setup.isPending ? t("setup.submitting") : t("setup.submit")}
            </Button>
          </AuthForm>
        </>
      )}
    </AuthShell>
  );
}
