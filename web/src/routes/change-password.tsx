import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { useChangePassword } from "@/hooks/auth";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/change-password")({
  component: ChangePasswordPage,
});

// ChangePasswordPage is where must_change_password users land after sign-in. Other sessions are
// revoked by the server once the password changes.
function ChangePasswordPage() {
  const change = useChangePassword();
  const navigate = useNavigate();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const current_password = String(form.get("current_password") ?? "");
    const new_password = String(form.get("new_password") ?? "");
    const fieldErrs: Record<string, string> = {};
    if (!current_password) fieldErrs.current_password = "Enter your current password.";
    if (new_password.length < 12) fieldErrs.new_password = "Use at least 12 characters.";
    setErrors(fieldErrs);
    setFormError(null);
    if (Object.keys(fieldErrs).length > 0) return;

    change.mutate(
      { current_password, new_password },
      {
        onSuccess: () => {
          void navigate({ to: "/" });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) return setFormError("Something went wrong. Try again.");
          if (err.code === "invalid_credentials") {
            return setErrors({ current_password: "Current password is wrong." });
          }
          if (err.status === 422) return setErrors(err.fieldErrors());
          setFormError(err.message);
        },
      },
    );
  }

  return (
    <AuthShell title="Change password">
      <p className="mb-4 text-sm text-muted">Choose a new password before you continue.</p>
      <AuthForm errors={errors} onSubmit={onSubmit}>
        <FormField
          label="Current password"
          name="current_password"
          type="password"
          autoComplete="current-password"
          error={errors.current_password}
        />
        <FormField
          label="New password"
          name="new_password"
          type="password"
          autoComplete="new-password"
          error={errors.new_password}
        />
        {formError ? (
          <p role="alert" className="text-sm text-danger">
            {formError}
          </p>
        ) : null}
        <Button type="submit" disabled={change.isPending}>
          {change.isPending ? "Saving…" : "Change password"}
        </Button>
      </AuthForm>
    </AuthShell>
  );
}
