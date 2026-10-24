import { ShieldCheck as ShieldCheckTile } from "lucide-react";
import { IconTile } from "@/components/ui/icon-tile";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { QueryError } from "@/components/features/empty/query-error";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/api";
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
} from "./hooks";

// SecurityPage is the account security page: two-factor auth, sessions and login history.
export function SecurityPage() {
  const me = useMe();

  if (me.isError) {
    return <QueryError error={me.error} onRetry={() => void me.refetch()} notFoundTitle="Account not found" />;
  }
  if (me.isPending) return <Skeleton className="h-64 w-full" />;

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 px-4 py-8">
      <header>
        <h1 className="flex items-center gap-3 text-2xl font-semibold tracking-[-0.01em]"><IconTile icon={ShieldCheckTile} entity="security" size="md" />Account security</h1>
        <p className="text-sm text-muted">{me.data.user.email}</p>
      </header>

      {me.data.mfa_enrollment_required ? (
        <p role="alert" className="rounded-md border border-line bg-surface p-3 text-sm">
          This instance requires two-factor authentication. Set it up to keep using Runtime Web.
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
  if (!enabled) {
    return (
      <section aria-labelledby="mfa-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="mfa-heading" className="text-base font-semibold">
            Two-factor authentication
          </h2>
          <p className="text-sm text-muted">Ask for a code from your authenticator app each time you sign in.</p>
        </div>
        <EnrollTotp />
      </section>
    );
  }
  return (
    <section aria-labelledby="mfa-heading" className="flex flex-col gap-6">
      <div>
        <h2 id="mfa-heading" className="text-base font-semibold">
          Two-factor authentication
        </h2>
        <p className="text-sm text-muted">Two-factor authentication is on.</p>
      </div>
      <RegenerateCodes />
      <DisableTotp />
    </section>
  );
}

function RegenerateCodes() {
  const regen = useRegenerateRecoveryCodes();
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    if (!password) {
      setError("Enter your password.");
      return;
    }
    setError(null);
    regen.mutate(
      { password },
      {
        onSuccess: (res) => setCodes(res.recovery_codes),
        onError: (err) => {
          setError(err instanceof ApiError && err.code === "invalid_credentials" ? "That password is not right." : "Could not create new codes.");
        },
      },
    );
  }

  if (codes) return <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-muted">Recovery codes</h3>
      <p className="text-sm text-muted">Creating new codes makes your old codes stop working.</p>
      <AuthForm errors={error ? { password: error } : {}} onSubmit={onSubmit}>
        <FormField label="Password" name="password" type="password" autoComplete="current-password" error={error ?? undefined} />
        <div>
          <Button type="submit" variant="secondary" disabled={regen.isPending}>
            Create new recovery codes
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}

function DisableTotp() {
  const disable = useDisableTotp();
  const me = useMe();
  const [error, setError] = useState<string | null>(null);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const password = String(data.get("password") ?? "");
    const code = String(data.get("code") ?? "").trim();
    if (!password || !code) {
      setError("Enter your password and a code.");
      return;
    }
    setError(null);
    disable.mutate(
      { password, code },
      {
        onSuccess: () => toast.success("Two-factor authentication is off."),
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid_credentials") setError("That password is not right.");
          else if (err instanceof ApiError && err.code === "invalid_code") setError("That code is not right.");
          else setError("Could not turn off 2FA.");
        },
      },
    );
  }

  if (me.data?.mfa_enrollment_required) return null;

  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-[13px] font-medium text-muted">Turn off two-factor authentication</h3>
      <AuthForm errors={error ? { code: error } : {}} onSubmit={onSubmit}>
        <FormField label="Password" name="password" type="password" autoComplete="current-password" />
        <FormField label="Authentication code" name="code" inputMode="numeric" autoComplete="one-time-code" error={error ?? undefined} />
        <div>
          <Button type="submit" variant="danger" disabled={disable.isPending}>
            Turn off 2FA
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}

function SessionsSection() {
  const sessions = useSessions();
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();

  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="sessions-heading" className="text-base font-semibold">
            Sessions
          </h2>
          <p className="text-sm text-muted">Devices signed in to your account.</p>
        </div>
        {sessions.data && sessions.data.some((s) => !s.current) ? (
          <Button
            variant="secondary"
            disabled={revokeOthers.isPending}
            onClick={() =>
              revokeOthers.mutate(undefined, {
                onSuccess: (res) => toast.success(`Signed out ${res.revoked} other session(s).`),
              })
            }
          >
            Sign out other sessions
          </Button>
        ) : null}
      </header>

      {sessions.isError ? (
        <QueryError error={sessions.error} onRetry={() => void sessions.refetch()} notFoundTitle="Sessions not found" />
      ) : sessions.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <ul aria-label="Sessions" className="divide-y divide-line rounded-md border border-line bg-surface">
          {sessions.data.map((s) => (
            <li key={s.id} className="group flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
              <span>
                <span className="font-medium">{describeUserAgent(s.ua)}</span>
                <span className="block text-muted">
                  {s.ip} · last active {new Date(s.last_seen_at).toLocaleString()}
                </span>
              </span>
              {s.current ? (
                <Badge variant="info">This session</Badge>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                  aria-label={`Revoke session ${describeUserAgent(s.ua)}`}
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(s.id)}
                >
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LoginHistorySection() {
  const logins = useLogins();

  return (
    <section aria-labelledby="logins-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="logins-heading" className="text-base font-semibold">
          Login history
        </h2>
        <p className="text-sm text-muted">Recent sign-in attempts on your account.</p>
      </div>
      {logins.isError ? (
        <QueryError error={logins.error} onRetry={() => void logins.refetch()} notFoundTitle="History not found" />
      ) : logins.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : logins.data.length === 0 ? (
        <EmptyState entity="security" title="No sign-ins yet" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When</TableHead>
              <TableHead>Device</TableHead>
              <TableHead>Method</TableHead>
              <TableHead>Result</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {logins.data.map((e) => (
              <TableRow key={e.id}>
                <TableCell>{new Date(e.at).toLocaleString()}</TableCell>
                <TableCell>{describeUserAgent(e.ua)}</TableCell>
                <TableCell>{e.method}</TableCell>
                <TableCell>{e.result === "ok" ? "Signed in" : e.result.replace(/_/g, " ")}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
