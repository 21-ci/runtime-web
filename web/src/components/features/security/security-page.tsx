import { ShieldCheck as ShieldCheckTile } from "lucide-react";
import { BoundedItems } from "@/components/ui/bounded";
import { PageHeader } from "@/components/ui/page-header";
import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { describeUserAgent } from "@/lib/user-agent";

import { EnrollTotp, RecoveryCodes } from "./enroll-2fa";
import { LinkedSignInSection } from "./linked-sign-in";
import {
  useDisableTotp,
  useLogins,
  useMe,
  useRegenerateRecoveryCodes,
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  type LoginEvent,
  type SessionInfo,
} from "./hooks";

const RESULT_KEY = {
  ok: "logins.results.ok",
  bad_password: "logins.results.bad_password",
  bad_totp: "logins.results.bad_totp",
  rate_limited: "logins.results.rate_limited",
  disabled: "logins.results.disabled",
  sso_only: "logins.results.sso_only",
  mfa_pending: "logins.results.mfa_pending",
} as const satisfies Record<LoginEvent["result"], string>;

const METHOD_KEY = {
  password: "logins.methods.password",
  oauth: "logins.methods.oauth",
  invite: "logins.methods.invite",
} as const satisfies Record<LoginEvent["method"], string>;

// SecurityPage is the account security page: two-factor auth, sessions and login history.
export function SecurityPage() {
  const me = useMe();
  const { t } = useTranslation(["security", "common"]);

  if (me.isError) {
    return <QueryError error={me.error} onRetry={() => void me.refetch()} notFoundTitle={t("accountNotFound")} />;
  }
  if (me.isPending) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      <PageHeader icon={ShieldCheckTile} entity="security" title={t("title")} description={me.data.user.email} />

      {me.data.mfa_enrollment_required ? (
        <p role="alert" className="rounded-lg border border-line bg-surface p-4 shadow-card text-sm">
          {t("mfaRequired")}
        </p>
      ) : null}

      <TwoFactorSection enabled={me.data.user.totp_enabled} />
      <LinkedSignInSection />
      <SessionsSection />
      <LoginHistorySection />
    </div>
  );
}

function TwoFactorSection({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("security");
  if (!enabled) {
    return (
      <section aria-labelledby="mfa-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
        <div>
          <h2 id="mfa-heading" className="text-[15px] font-semibold">
            {t("twoFactor.title")}
          </h2>
          <p className="text-sm text-muted">{t("twoFactor.description")}</p>
        </div>
        <EnrollTotp />
      </section>
    );
  }
  return (
    <section aria-labelledby="mfa-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 id="mfa-heading" className="text-[15px] font-semibold">
          {t("twoFactor.title")}
        </h2>
        <p className="text-sm text-muted">{t("twoFactor.on")}</p>
      </div>
      <RegenerateCodes />
      <DisableTotp />
    </section>
  );
}

function RegenerateCodes() {
  const regen = useRegenerateRecoveryCodes();
  const { t } = useTranslation("security");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    if (!password) {
      setError(t("enterPassword"));
      return;
    }
    setError(null);
    regen.mutate(
      { password },
      {
        onSuccess: (res) => setCodes(res.recovery_codes),
        onError: (err) => {
          setError(
            err instanceof ApiError && err.code === "invalid_credentials" ? t("wrongPassword") : t("recovery.regenFailed"),
          );
        },
      },
    );
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-muted">{t("recovery.title")}</h3>
      <p className="text-sm text-muted">{t("recovery.regenDescription")}</p>
      <AuthForm errors={error ? { password: error } : {}} onSubmit={onSubmit}>
        <FormField label={t("passwordLabel")} name="password" type="password" autoComplete="current-password" error={error ?? undefined} />
        <div>
          <Button type="submit" variant="secondary" disabled={regen.isPending}>
            {t("recovery.regenerate")}
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}

function DisableTotp() {
  const disable = useDisableTotp();
  const me = useMe();
  const { t } = useTranslation("security");
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") ?? "");
    const code = String(data.get("code") ?? "").trim();
    if (!password || !code) {
      setError(t("disable.required"));
      return;
    }
    setError(null);
    disable.mutate(
      { password, code },
      {
        onSuccess: () => toast.success(t("toast.twoFactorOff")),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid_credentials") setError(t("wrongPassword"));
          else if (err instanceof ApiError && err.code === "invalid_code") setError(t("wrongCode"));
          else setError(t("disable.failed"));
        },
      },
    );
  }

  if (me.data?.mfa_enrollment_required) return null;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-muted">{t("disable.title")}</h3>
      <AuthForm errors={error ? { code: error } : {}} onSubmit={onSubmit}>
        <FormField label={t("passwordLabel")} name="password" type="password" autoComplete="current-password" />
        <FormField label={t("codeLabel")} name="code" inputMode="numeric" autoComplete="one-time-code" error={error ?? undefined} />
        <div>
          <Button type="submit" variant="danger" disabled={disable.isPending}>
            {t("disable.button")}
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}

// orderedSessions puts the current session first, then groups the others by device so one device's
// sessions sit together.
function orderedSessions(items: SessionInfo[]): SessionInfo[] {
  return [...items].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return describeUserAgent(a.ua).localeCompare(describeUserAgent(b.ua));
  });
}

function SessionsSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const { t } = useTranslation(["security", "common"]);

  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="sessions-heading" className="text-[15px] font-semibold">
            {t("sessions.title")}
          </h2>
          <p className="text-sm text-muted">{t("sessions.description")}</p>
        </div>
        {sessions.data && sessions.data.some((s) => !s.current) ? (
          <Button
            variant="secondary"
            disabled={revokeOthers.isPending}
            onClick={() =>
              revokeOthers.mutate(undefined, {
                onSuccess: (res) => toast.success(t("toast.signedOut", { count: res.revoked })),
              })
            }
          >
            {t("sessions.signOutOthers")}
          </Button>
        ) : null}
      </header>

      {sessions.isError ? (
        <QueryError error={sessions.error} onRetry={() => void sessions.refetch()} notFoundTitle={t("sessionsNotFound")} />
      ) : sessions.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <BoundedItems
          items={orderedSessions(sessions.data)}
          getKey={(s) => s.id}
          maxItems={10}
          renderItem={(s) => (
            <div className="group flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3 text-sm last:border-b-0">
              <span>
                <span className="font-medium">{describeUserAgent(s.ua)}</span>
                <span className="block text-muted">
                  {t("sessions.lastActive", { ip: s.ip, time: formatDateTime(s.last_seen_at) })}
                </span>
              </span>
              {s.current ? (
                <Badge variant="info">{t("sessions.current")}</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={t("sessions.revokeLabel", { device: describeUserAgent(s.ua) })}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s.id)}
                >
                  {t("sessions.revoke")}
                </Button>
              )}
            </div>
          )}
          className="rounded-lg border border-line bg-surface shadow-card"
        />
      )}
    </section>
  );
}

function LoginHistorySection() {
  const logins = useLogins();
  const { t } = useTranslation(["security", "common"]);

  return (
    <section aria-labelledby="logins-heading" className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 id="logins-heading" className="text-[15px] font-semibold">
          {t("logins.title")}
        </h2>
        <p className="text-sm text-muted">{t("logins.description")}</p>
      </div>
      {logins.isError ? (
        <QueryError error={logins.error} onRetry={() => void logins.refetch()} notFoundTitle={t("historyNotFound")} />
      ) : logins.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : logins.data.length === 0 ? (
        <EmptyState entity="security" title={t("logins.empty")} />
      ) : (
        <BoundedItems
          items={logins.data}
          getKey={(e) => e.id}
          maxItems={10}
          collapseId="security.logins"
          title={t("logins.title")}
          renderItem={(e) => (
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-line py-2 text-sm last:border-b-0">
              <span className="min-w-0">
                <span className="font-medium">{describeUserAgent(e.ua)}</span>
                <span className="block text-[13px] text-muted">
                  {formatDateTime(e.at)} · {t(METHOD_KEY[e.method])}
                </span>
              </span>
              <Badge variant={e.result === "ok" ? "success" : "outline"}>{t(RESULT_KEY[e.result])}</Badge>
            </div>
          )}
        />
      )}
    </section>
  );
}
