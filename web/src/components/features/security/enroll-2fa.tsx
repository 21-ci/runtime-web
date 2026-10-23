import { useEffect, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download, Printer } from "lucide-react";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

import { useConfirmTotp, useEnrollTotp } from "./hooks";

// RecoveryCodes shows the single-use codes once, with download and print. Dismissing the panel
// drops them from the page.
export function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  function download() {
    const blob = new Blob([`Runtime Web recovery codes\n\n${codes.join("\n")}\n`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "runtime-web-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col gap-3 rounded-[6px] border border-line bg-panel p-4">
      <div>
        <h3 className="text-sm font-semibold">Recovery codes</h3>
        <p className="text-sm text-muted">
          Each code works once when you cannot use your authenticator. Store them somewhere safe. They are shown only
          now.
        </p>
      </div>
      <ul className="grid grid-cols-2 gap-2 font-mono text-sm" aria-label="Recovery codes">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" aria-label="Download recovery codes" onClick={download}>
          <Download className="size-4" aria-hidden />
          Download
        </Button>
        <Button variant="secondary" size="sm" aria-label="Print recovery codes" onClick={() => window.print()}>
          <Printer className="size-4" aria-hidden />
          Print
        </Button>
        <Button size="sm" onClick={onDone}>
          I have saved my recovery codes
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
  const [otpauth, setOtpauth] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  function start() {
    enroll.mutate(undefined, {
      onSuccess: (res) => setOtpauth(res.otpauth_url),
      onError: () => setError("Could not start 2FA setup. Try again."),
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code") ?? "").trim();
    if (!code) {
      setError("Enter the 6-digit code from your app.");
      return;
    }
    setError(null);
    confirm.mutate(code, {
      onSuccess: (res) => setCodes(res.recovery_codes),
      onError: (err) => {
        if (err instanceof ApiError && err.code === "invalid_code") setError("That code is not right. Try again.");
        else if (err instanceof ApiError && err.code === "rate_limited") setError("Too many attempts. Wait and try again.");
        else setError("Could not turn on 2FA. Start again.");
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

  if (!otpauth) {
    return (
      <Button onClick={start} disabled={enroll.isPending}>
        Set up two-factor authentication
      </Button>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">Scan this QR code with your authenticator app, then enter the 6-digit code it shows.</p>
      {qr ? (
        <img src={qr} alt="QR code for your authenticator app" width={192} height={192} className="rounded-[6px] bg-white p-2" />
      ) : (
        <p className="text-sm text-muted">Preparing the QR code</p>
      )}
      <p className="text-sm">
        Cannot scan? Enter this key: <code className="font-mono">{secret}</code>
      </p>
      <AuthForm errors={error ? { code: error } : {}} onSubmit={onSubmit}>
        <FormField
          label="Authentication code"
          name="code"
          inputMode="numeric"
          autoComplete="one-time-code"
          error={error ?? undefined}
        />
        <div>
          <Button type="submit" disabled={confirm.isPending}>
            Turn on 2FA
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}
