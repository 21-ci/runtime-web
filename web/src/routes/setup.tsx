import { useState, type FormEvent } from "react";
import { createFileRoute, Navigate, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useBranding } from "@/components/features/branding/hooks";
import { useSetup, useSetupStatus } from "@/hooks/auth";
import { ApiError } from "@/lib/api";

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
    if (!values.setup_token) fieldErrs.setup_token = "Enter the setup token.";
    if (!values.email) fieldErrs.email = "Enter an email.";
    if (!values.name) fieldErrs.name = "Enter a name.";
    if (values.password.length < 12) fieldErrs.password = "Use at least 12 characters.";
    setErrors(fieldErrs);
    setFormError(null);
    if (Object.keys(fieldErrs).length > 0) return;

    setup.mutate(values, {
      onSuccess: () => {
        void navigate({ to: "/" });
      },
      onError: (err) => {
        if (!(err instanceof ApiError)) return setFormError("Something went wrong. Try again.");
        if (err.code === "setup_token_invalid") return setErrors({ setup_token: "That setup token is wrong." });
        if (err.code === "already_set_up") return void navigate({ to: "/login", search: {} });
        if (err.status === 422) return setErrors(err.fieldErrors());
        setFormError(err.message);
      },
    });
  }

  return (
    <AuthShell title={`Set up ${brand?.product_name || "Runtime"}`} description="Create the first admin account. It only takes a minute.">
      {status.isPending ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted">
            Create the first admin. Find the setup token in the server environment or the startup log.
          </p>
          <AuthForm errors={errors} onSubmit={onSubmit}>
            <FormField
              label="Setup token"
              name="setup_token"
              type="password"
              autoComplete="off"
              error={errors.setup_token}
            />
            <FormField label="Email" name="email" type="email" autoComplete="username" error={errors.email} />
            <FormField label="Name" name="name" autoComplete="name" error={errors.name} />
            <FormField
              label="Password"
              name="password"
              type="password"
              autoComplete="new-password"
              hint="At least 12 characters."
              error={errors.password}
            />
            {formError ? (
              <p role="alert" className="text-sm text-danger">
                {formError}
              </p>
            ) : null}
            <Button type="submit" variant="default" disabled={setup.isPending}>
              {setup.isPending ? "Creating…" : "Create admin"}
            </Button>
          </AuthForm>
        </>
      )}
    </AuthShell>
  );
}
