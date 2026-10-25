import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

import { useConfirmTotp, useEnrollTotp } from "./hooks";

// RecoveryCodes shows the single-use codes once, with download and print. Dismissing the panel
// drops them from the page.
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useTranslation("security");

  function download() {
    const blob = new Blob([`${t("recovery.fileHeader")}\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "runtime-web-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-panel p-4">
      <div>
        <h3 className="text-[13px] font-medium text-muted">{t("recovery.title")}</h3>
        <p className="text-sm text-muted">{t("recovery.description")}</p>
      </div>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label={t("recovery.title")}>
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" aria-label={t("recovery.downloadLabel")} onClick={download}>
          <Download className="size-4" aria-hidden />
          {t("recovery.download")}
        </Button>
        <Button variant="secondary" size="sm" aria-label={t("recovery.printLabel")} onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          {t("recovery.print")}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t("recovery.saved")}
        </Button>
      </div>
    </div>
  );
}

// EnrollTotp runs the 2FA setup in two steps: scan the QR (or type the secret), then confirm one
// code. The recovery codes come back with the confirmation and are shown once.
export function EnrollTotp({ onDone }: { onDone?: () => void }) {
  const qc = useQueryClient();
  const enroll = useEnrollTotp();
  const confirm = useConfirmTotp();
  const { t } = useTranslation("security");
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState(false);

  useEffect(() => {
    if (!otpauth) return;
    let cancelled = false;
    // qrcode is loaded on demand so the security page stays small.
    void import("qrcode").then(async (mod) => {
      const url = await mod.default.toDataURL(otpauth, { margin: 1, width: 192 });
      if (!cancelled) setQr(url);
    });
    return () => {
      cancelled = true;
    };
  }, [otpauth]);

  const secret = otpauth ? new URL(otpauth).searchParams.get("secret") : null;

  function onPasswordSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    if (!password) {
      setError(t("enroll.enterPassword"));
      return;
    }
    setError(null);
    enroll.mutate(
      { password },
      {
        onSuccess: (res) => {
          setAskPassword(false);
          setOtpauth(res.otpauth_url);
        },
        onError: (err) => {
          if (err instanceof ApiError && err.code === "invalid_credentials") setError(t("enroll.wrongPassword"));
          else if (err instanceof ApiError && err.code === "rate_limited") setError(t("enroll.rateLimited"));
          else setError(t("enroll.failed"));
        },
      },
    );
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!code) {
      setError(t("enroll.codeRequired"));
      return;
    }
    setError(null);
    confirm.mutate(code, {
      onSuccess: (res) => setCodes(res.recovery_codes),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "invalid_code") setError(t("enroll.invalidCode"));
        else if (err instanceof ApiError && err.code === "rate_limited") setError(t("enroll.rateLimited"));
        else setError(t("enroll.confirmFailed"));
      },
    });
  }

  if (codes) {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          setCodes(null);
          setOtpauth(null);
          setQr(null);
          void qc.invalidateQueries({ queryKey: ["me"] });
          onDone?.();
        }}
      />
    );
  }

  if (!otpauth && !askPassword) {
    return (
      <Button
        onClick={() => {
          setError(null);
          setAskPassword(true);
        }}
      >
        {t("twoFactor.setUp")}
      </Button>
    );
  }

  if (!otpauth) {
    return (
      <AuthForm errors={error ? { password: error } : {}} onSubmit={onPasswordSubmit}>
        <p className="text-sm">{t("enroll.passwordPrompt")}</p>
        <FormField
          label={t("currentPasswordLabel")}
          name="password"
          type="password"
          autoComplete="current-password"
          error={error ?? undefined}
        />
        <div>
          <Button type="submit" disabled={enroll.isPending}>
            {t("enroll.continue")}
          </Button>
        </div>
      </AuthForm>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">{t("enroll.scan")}</p>
      {qr ? (
        <img src={qr} alt={t("enroll.qrAlt")} width={192} height={192} className="rounded-md bg-white p-2" />
      ) : (
        <p className="text-sm text-muted">{t("enroll.preparingQr")}</p>
      )}
      <p className="text-sm">
        {t("enroll.cannotScan")} <code className="break-all font-mono">{secret}</code>
      </p>
      <AuthForm errors={error ? { code: error } : {}} onSubmit={onSubmit}>
        <FormField
          label={t("codeLabel")}
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          error={error ?? undefined}
        />
        <div>
          <Button type="submit" variant="default" disabled={confirm.isPending}>
            {t("enroll.turnOn")}
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}
