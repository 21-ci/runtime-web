import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, type Ingress, usePatchApp } from "./api";
import { isCidr } from "./cidr";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

// IngressSection edits methods, path prefixes, ip_allow CIDRs and rate_limit. Each list entry is its
// own input, so a server error like "ingress.ip_allow[2]" lands on the third IP row.
export function IngressSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const initial: Ingress = app.ingress ?? {};
  const [methods, setMethods] = useState<string[]>(initial.methods ?? []);
  const [prefixes, setPrefixes] = useState<string[]>(initial.path_prefixes?.length ? initial.path_prefixes : [""]);
  const [ipAllow, setIpAllow] = useState<string[]>(initial.ip_allow?.length ? initial.ip_allow : [""]);
  const [rateLimit, setRateLimit] = useState(
    initial.rate_limit ? JSON.stringify(initial.rate_limit, null, 2) : "",
  );
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  function setAt(list: string[], setList: (v: string[]) => void, i: number, v: string) {
    setList(list.map((x, j) => (j === i ? v : x)));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const local: Record<string, string> = {};
    // Rows are not dropped when blank so that list indexes match the server's ip_allow[i] paths.
    const cidrs = ipAllow.map((v) => v.trim());
    cidrs.forEach((cidr, i) => {
      if (!isCidr(cidr)) local[`ingress.ip_allow[${i}]`] = t("ingress.ipInvalid");
    });
    let rate: Record<string, unknown> | undefined;
    if (rateLimit.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(rateLimit);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not object");
        rate = parsed as Record<string, unknown>;
      } catch {
        local["ingress.rate_limit"] = t("ingress.rateLimitInvalid");
      }
    }
    setFields(local);
    setErrors([]);
    if (Object.keys(local).length > 0) return;

    const body: Ingress = {
      methods,
      path_prefixes: prefixes.map((v) => v.trim()).filter((v) => v !== ""),
      ip_allow: cidrs,
    };
    if (rate) body.rate_limit = rate;
    try {
      await patch.mutateAsync({ etag: app.etag, body: { ingress: body } });
      setFields({});
      toast.success(t("ingress.saved"));
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFields(server);
      const shown = [...ipAllow.map((_, i) => `ingress.ip_allow[${i}]`), "ingress.rate_limit"];
      setErrors(unmappedErrors(server, shown));
    }
  }

  // The server path "ingress.ip_allow[i]" maps to row i; other server paths go to the alert.
  const ipError = (i: number) => fields[`ingress.ip_allow[${i}]`];

  return (
    <Section id="ingress" title={t("ingress.title")} description={t("ingress.description")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-label={t("ingress.formLabel")}>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-[13px] font-medium text-text">{t("ingress.methods")}</legend>
          <div className="flex flex-wrap gap-3">
            {METHODS.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={methods.includes(m)}
                  onChange={(e) =>
                    setMethods(e.target.checked ? [...methods, m] : methods.filter((x) => x !== m))
                  }
                />
                {m}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-text">{t("ingress.pathPrefixes")}</p>
          {prefixes.map((v, i) => (
            <div key={i} className="flex items-center gap-2">
              <Label htmlFor={`prefix-${i}`} className="sr-only">
                {t("ingress.pathPrefix", { index: i + 1 })}
              </Label>
              <Input
                id={`prefix-${i}`}
                value={v}
                placeholder="/api"
                onChange={(e) => setAt(prefixes, setPrefixes, i, e.target.value)}
              />
              <Button
                type="button"
                variant="ghost"
                aria-label={t("ingress.removePathPrefix", { index: i + 1 })}
                onClick={() => setPrefixes(prefixes.filter((_, j) => j !== i))}
              >
                {t("common:remove")}
              </Button>
            </div>
          ))}
          <div>
            <Button type="button" variant="secondary" onClick={() => setPrefixes([...prefixes, ""])}>
              {t("ingress.addPathPrefix")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-text">{t("ingress.ipRanges")}</p>
          {ipAllow.map((v, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <Label htmlFor={`ip-${i}`} className="sr-only">
                  {t("ingress.ipAllow", { index: i + 1 })}
                </Label>
                <Input
                  id={`ip-${i}`}
                  value={v}
                  placeholder="10.0.0.0/8"
                  aria-invalid={Boolean(ipError(i))}
                  aria-describedby={ipError(i) ? `ip-${i}-error` : undefined}
                  onChange={(e) => setAt(ipAllow, setIpAllow, i, e.target.value)}
                />
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={t("ingress.removeIpAllow", { index: i + 1 })}
                  onClick={() => setIpAllow(ipAllow.filter((_, j) => j !== i))}
                >
                  {t("common:remove")}
                </Button>
              </div>
              <FieldError id={`ip-${i}-error`} message={ipError(i)} />
            </div>
          ))}
          <div>
            <Button type="button" variant="secondary" onClick={() => setIpAllow([...ipAllow, ""])}>
              {t("ingress.addIpRange")}
            </Button>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="rate-limit">{t("ingress.rateLimit")}</Label>
          <textarea
            id="rate-limit"
            value={rateLimit}
            onChange={(e) => setRateLimit(e.target.value)}
            rows={4}
            spellCheck={false}
            autoComplete="off"
            className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus"
            aria-describedby="rate-limit-error"
          />
          <FieldError id="rate-limit-error" message={fields["ingress.rate_limit"]} />
        </div>

        <FormAlert messages={errors} />
        <p className="text-sm text-muted">{t("replaceNote")}</p>
        <div>
          <SaveButton disabled={patch.isPending}>
            {t("ingress.save")}
          </SaveButton>
        </div>
      </form>
    </Section>
  );
}
