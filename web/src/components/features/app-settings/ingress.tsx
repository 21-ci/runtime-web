import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { type AppDetail, type Ingress, type RateRule, usePatchApp } from "./api";
import { isCidr } from "./cidr";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const;

const RULES_MAX = 32;
type RuleDraft = { path: string; methods: string; rps: string; burst: string; by: "service" | "ip" };

const toDraft = (r: RateRule): RuleDraft => ({
  path: r.path,
  methods: (r.methods ?? []).join(", "),
  rps: String(r.rps),
  burst: r.burst ? String(r.burst) : "",
  by: r.by === "ip" ? "ip" : "service",
});

/** Numbers that do not parse go through as written: the server names the field, as for every other input here. */
const toWire = (d: RuleDraft): RateRule => {
  const methods = d.methods.split(",").map((m) => m.trim().toUpperCase()).filter(Boolean);
  return {
    path: d.path.trim(),
    ...(methods.length ? { methods } : {}),
    rps: Number(d.rps),
    ...(d.burst.trim() ? { burst: Number(d.burst) } : {}),
    by: d.by,
  };
};

// The first matching rule applies, so order matters: rows can move.
function RateRules({ rules, onChange, fields }: { rules: RuleDraft[]; onChange: (r: RuleDraft[]) => void; fields: Record<string, string> }) {
  const { t } = useTranslation(["platform", "common"]);
  const set = (i: number, patch: Partial<RuleDraft>) => onChange(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const move = (i: number, by: number) => {
    const next = [...rules];
    const [row] = next.splice(i, 1);
    if (row) next.splice(i + by, 0, row);
    onChange(next);
  };
  return (
    <fieldset className="flex flex-col gap-3">
      <legend className="mb-1 text-[13px] font-medium text-text">{t("platform:rateRules.title")}</legend>
      <p className="text-sm text-muted">{t("platform:rateRules.hint")}</p>
      {rules.map((r, i) => {
        const err = (f: string) => fields[`ingress.rate_rules[${i}].${f}`];
        const n = i + 1;
        return (
          <div key={i} className="grid gap-2 rounded-md border border-line p-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rule-path-${i}`}>{t("platform:rateRules.path", { n })}</Label>
              <Input id={`rule-path-${i}`} value={r.path} placeholder="/api/login" onChange={(e) => set(i, { path: e.target.value })} />
              <FieldError id={`rule-path-${i}-error`} message={err("path")} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rule-methods-${i}`}>{t("platform:rateRules.methods", { n })}</Label>
              <Input id={`rule-methods-${i}`} value={r.methods} placeholder="POST, PUT" onChange={(e) => set(i, { methods: e.target.value })} />
              <FieldError id={`rule-methods-${i}-error`} message={err("methods")} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rule-rps-${i}`}>{t("platform:rateRules.rps", { n })}</Label>
              <Input id={`rule-rps-${i}`} inputMode="numeric" value={r.rps} onChange={(e) => set(i, { rps: e.target.value })} />
              <FieldError id={`rule-rps-${i}-error`} message={err("rps")} />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor={`rule-burst-${i}`}>{t("platform:rateRules.burst", { n })}</Label>
              <Input id={`rule-burst-${i}`} inputMode="numeric" value={r.burst} onChange={(e) => set(i, { burst: e.target.value })} />
              <FieldError id={`rule-burst-${i}-error`} message={err("burst")} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={r.by === "ip"} onChange={(e) => set(i, { by: e.target.checked ? "ip" : "service" })} />
              {t("platform:rateRules.perClient", { n })}
            </label>
            <div className="flex justify-end gap-1">
              <Button type="button" size="sm" variant="ghost" disabled={i === 0} aria-label={t("platform:rateRules.up", { n })} onClick={() => move(i, -1)}>↑</Button>
              <Button type="button" size="sm" variant="ghost" disabled={i === rules.length - 1} aria-label={t("platform:rateRules.down", { n })} onClick={() => move(i, 1)}>↓</Button>
              <Button type="button" size="sm" variant="ghost" aria-label={t("platform:rateRules.remove", { n })} onClick={() => onChange(rules.filter((_, j) => j !== i))}>{t("common:remove")}</Button>
            </div>
          </div>
        );
      })}
      <div>
        <Button type="button" variant="secondary" disabled={rules.length >= RULES_MAX} onClick={() => onChange([...rules, { path: "", methods: "", rps: "", burst: "", by: "service" }])}>
          {t("platform:rateRules.add")}
        </Button>
      </div>
    </fieldset>
  );
}

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
  const [rules, setRules] = useState<RuleDraft[]>((initial.rate_rules ?? []).map(toDraft));
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
    body.rate_rules = rules.map(toWire);
    try {
      await patch.mutateAsync({ etag: app.etag, body: { ingress: body } });
      setFields({});
      toast.success(t("ingress.saved"));
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFields(server);
      const shown = [
        ...ipAllow.map((_, i) => `ingress.ip_allow[${i}]`),
        "ingress.rate_limit",
        ...rules.flatMap((_, i) => ["path", "rps", "burst", "by", "methods"].map((f) => `ingress.rate_rules[${i}].${f}`)),
      ];
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

        <RateRules rules={rules} onChange={setRules} fields={fields} />

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
