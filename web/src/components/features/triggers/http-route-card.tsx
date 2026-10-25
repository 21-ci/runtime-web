import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { usePatchApp, type AppView } from "@/components/features/app-header/hooks";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const ACCESS = [
  { value: "public", labelKey: "http.accessOptions.public", hintKey: "http.accessHint.public" },
  { value: "key", labelKey: "http.accessOptions.key", hintKey: "http.accessHint.key" },
  { value: "internal", labelKey: "http.accessOptions.internal", hintKey: "http.accessHint.internal" },
] as const;

// HttpRouteCard edits who can reach the app over HTTP (access) and which methods and paths the
// ingress accepts. The runtime replaces the whole ingress block, so the IP allow-list and rate
// limit are carried over unchanged from the current view.
export function HttpRouteCard({ org, app, view }: { org: string; app: string; view: AppView }) {
  const { t } = useTranslation(["triggers", "common"]);
  const patch = usePatchApp(org, app);
  const [access, setAccess] = useState<AppView["access"]>(view.access);
  const [methods, setMethods] = useState<string[]>(view.ingress?.methods ?? []);
  const [prefixes, setPrefixes] = useState((view.ingress?.path_prefixes ?? []).join("\n"));

  function toggleMethod(m: string, on: boolean) {
    setMethods((cur) => (on ? [...cur.filter((x) => x !== m), m] : cur.filter((x) => x !== m)));
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const pathList = prefixes
      .split("\n")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    patch.mutate(
      {
        etag: view.etag,
        body: {
          access,
          ingress: {
            ...(view.ingress ?? {}),
            methods: METHODS.filter((m) => methods.includes(m)),
            path_prefixes: pathList,
          },
        },
      },
      { onSuccess: () => toast.success(t("http.toast.saved")) },
    );
  }

  const hintKey = ACCESS.find((a) => a.value === access)?.hintKey;

  return (
    <section aria-labelledby="http-heading" className="flex flex-col gap-3">
      <div>
        <h2 id="http-heading" className="text-[15px] font-semibold">
          {t("http.title")}
        </h2>
        <p className="text-sm text-muted">{t("http.description")}</p>
      </div>
      <form onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="http-access">{t("http.access")}</Label>
          <Select value={access} onValueChange={(v) => setAccess(v as AppView["access"])}>
            <SelectTrigger id="http-access" aria-describedby="http-access-hint">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ACCESS.map((a) => (
                <SelectItem key={a.value} value={a.value}>
                  {t(a.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p id="http-access-hint" className="text-sm text-muted">
            {hintKey ? t(hintKey) : null}
          </p>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1.5 text-[13px] font-medium">{t("http.methods")}</legend>
          <div className="flex flex-wrap gap-3">
            {METHODS.map((m) => (
              <label key={m} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={methods.includes(m)}
                  onChange={(e) => toggleMethod(m, e.target.checked)}
                />
                {m}
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="http-prefixes">{t("http.prefixes")}</Label>
          <textarea
            id="http-prefixes"
            rows={3}
            value={prefixes}
            onChange={(e) => setPrefixes(e.target.value)}
            placeholder="/api…"
            spellCheck={false}
            autoComplete="off"
            className="rounded-sm border border-line-strong bg-surface p-2 font-mono text-sm text-text focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-focus focus-visible:outline-none"
          />
          <p className="text-sm text-muted">{t("http.keepNote")}</p>
        </div>

        <Button type="submit" variant="default" className="self-start" disabled={patch.isPending}>
          {patch.isPending ? t("common:saving") : t("http.save")}
        </Button>
      </form>
    </section>
  );
}
