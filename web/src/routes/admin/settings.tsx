import { useState, type FormEvent } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Settings } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import {
  useAdminSettings,
  useSaveAdminSettings,
  type InstanceSettings,
  type InstanceSettingsWrite,
  type OAuthProvider,
  type ProviderId,
} from "@/components/features/admin/use-admin";
import { BrandingSection } from "@/components/features/branding/branding-section";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/admin/settings")({
  component: AdminSettingsPage,
});

// Provider names are brands (GitHub, Google) and the OpenID Connect standard name, so they are not
// translated.
const PROVIDER_LABEL: Record<ProviderId, string> = {
  github: "GitHub",
  google: "Google",
  oidc: "OpenID Connect",
};

function AdminSettingsPage() {
  const { t } = useTranslation(["admin", "common"]);
  const settings = useAdminSettings();

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader icon={Settings} entity="admin" title={t("settings.title")} description={t("settings.description")} />
      {settings.isError ? (
        <QueryError error={settings.error} onRetry={() => void settings.refetch()} notFoundTitle={t("notAvailable")} />
      ) : settings.isPending ? (
        <div aria-busy="true">
          <Skeleton className="h-64 w-full" />
        </div>
      ) : (
        <SettingsForm initial={settings.data} />
      )}
      <BrandingSection />
    </div>
  );
}

type Draft = Omit<InstanceSettings, "public_url">;

function fromSettings(s: InstanceSettings): Draft {
  return {
    require_2fa: s.require_2fa,
    password_login_disabled: s.password_login_disabled,
    providers: s.providers,
  };
}

// SettingsForm edits instance policy and OAuth providers. The client secret is write-only: the
// field is always empty, and a blank value keeps the stored secret.
function SettingsForm({ initial }: { initial: InstanceSettings }) {
  const { t } = useTranslation(["admin", "common"]);
  const save = useSaveAdminSettings();
  const [draft, setDraft] = useState<Draft>(() => fromSettings(initial));
  const [secrets, setSecrets] = useState<Partial<Record<ProviderId, string>>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  const anyProviderEnabled = draft.providers.some((p) => p.enabled);
  // SSO-only needs a provider; an already-enabled SSO-only policy can still be turned off.
  const ssoDisabled = !anyProviderEnabled && !draft.password_login_disabled;

  function updateProvider(id: ProviderId, patch: Partial<OAuthProvider>) {
    setDraft((d) => ({ ...d, providers: d.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const body: InstanceSettingsWrite = {
      require_2fa: draft.require_2fa,
      password_login_disabled: draft.password_login_disabled,
      providers: draft.providers.map((p) => {
        const out: InstanceSettingsWrite["providers"][number] = {
          id: p.id,
          enabled: p.enabled,
          client_id: p.client_id,
        };
        if (p.id === "oidc") {
          out.issuer = p.issuer ?? "";
          out.name = p.name ?? "";
        }
        const secret = secrets[p.id];
        if (secret) out.client_secret = secret;
        return out;
      }),
    };
    setErrors({});
    save.mutate(body, {
      onSuccess: (data) => {
        setDraft(fromSettings(data));
        setSecrets({});
        toast.success(t("settings.saved"));
      },
      onError: (err) => {
        if (err instanceof ApiError && Object.keys(err.fieldErrors()).length > 0) {
          setErrors(err.fieldErrors());
        } else {
          toast.error(t("settings.saveFailed"));
        }
      },
    });
  }

  return (
    <form aria-label={t("settings.formLabel")} onSubmit={onSubmit} noValidate className="flex max-w-3xl min-w-0 flex-col gap-6">
      <section aria-labelledby="public-url-heading" className="flex flex-col gap-1.5">
        <h2 id="public-url-heading" className="text-[15px] font-semibold">
          {t("settings.publicUrl")}
        </h2>
        <Label htmlFor="public_url">{t("settings.publicUrl")}</Label>
        <Input id="public_url" name="public_url" value={initial.public_url} readOnly aria-describedby="public-url-hint" />
        <p id="public-url-hint" className="text-sm text-muted">
          {t("settings.publicUrlHint")}
        </p>
      </section>

      <section aria-labelledby="policy-heading" className="flex flex-col gap-3">
        <h2 id="policy-heading" className="text-[15px] font-semibold">
          {t("settings.policy")}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            name="require_2fa"
            checked={draft.require_2fa}
            onChange={(e) => setDraft((d) => ({ ...d, require_2fa: e.target.checked }))}
            className="size-4"
          />
          {t("settings.require2fa")}
        </label>

        <div className="flex flex-col gap-1">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              role="switch"
              name="password_login_disabled"
              checked={draft.password_login_disabled}
              disabled={ssoDisabled}
              aria-describedby="sso-hint"
              aria-invalid={errors.password_login_disabled ? true : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, password_login_disabled: e.target.checked }))}
              className="size-4"
            />
            {t("settings.ssoOnly")}
          </label>
          <p id="sso-hint" className="text-sm text-muted">
            {t("settings.ssoHint")}
          </p>
          {errors.password_login_disabled ? (
            <p className="text-sm text-danger">{errors.password_login_disabled}</p>
          ) : null}
        </div>
      </section>

      <section aria-labelledby="providers-heading" className="flex flex-col gap-4">
        <h2 id="providers-heading" className="text-[15px] font-semibold">
          {t("settings.providers")}
        </h2>
        {draft.providers.map((p) => {
          const name = p.id === "oidc" ? (p.name || PROVIDER_LABEL.oidc) : PROVIDER_LABEL[p.id];
          const secretId = `${p.id}-client-secret`;
          return (
            <fieldset key={p.id} className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-5 shadow-card">
              <legend className="px-1 text-[13px] font-medium">{name}</legend>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  role="switch"
                  aria-label={t("settings.enableProvider", { name })}
                  checked={p.enabled}
                  onChange={(e) => updateProvider(p.id, { enabled: e.target.checked })}
                  className="size-4"
                />
                {t("common:enabled")}
              </label>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={`${p.id}-client-id`}>{t("settings.clientId", { name })}</Label>
                <Input
                  id={`${p.id}-client-id`}
                  name={`${p.id}_client_id`}
                  value={p.client_id}
                  onChange={(e) => updateProvider(p.id, { client_id: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <div className="flex items-center gap-2">
                  <Label htmlFor={secretId}>{t("settings.clientSecret", { name })}</Label>
                  {p.client_secret_set ? <Badge variant="success">{t("settings.secretSet")}</Badge> : null}
                </div>
                <Input
                  id={secretId}
                  name={`${p.id}_client_secret`}
                  type="password"
                  autoComplete="new-password"
                  value={secrets[p.id] ?? ""}
                  placeholder={p.client_secret_set ? t("settings.secretKeep") : ""}
                  onChange={(e) => setSecrets((s) => ({ ...s, [p.id]: e.target.value }))}
                />
              </div>
              {p.id === "oidc" ? (
                <>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="oidc-issuer">{t("settings.issuer")}</Label>
                    <Input
                      id="oidc-issuer"
                      name="oidc_issuer"
                      value={p.issuer ?? ""}
                      onChange={(e) => updateProvider(p.id, { issuer: e.target.value })}
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="oidc-name">{t("settings.displayName")}</Label>
                    <Input
                      id="oidc-name"
                      name="oidc_name"
                      value={p.name ?? ""}
                      onChange={(e) => updateProvider(p.id, { name: e.target.value })}
                    />
                  </div>
                </>
              ) : null}
            </fieldset>
          );
        })}
      </section>

      <div>
        <Button type="submit" variant="default" disabled={save.isPending}>
          {t("settings.save")}
        </Button>
      </div>
    </form>
  );
}
