import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";
import { type AppDetail, usePatchApp } from "./api";
import { FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

// CallersSection picks which apps of this org may call this app (call.allowed_callers). The
// picker lists the org's apps, minus this one.
export function CallersSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const apps = useApps(org);
  const [selected, setSelected] = useState<string[]>(app.call?.allowed_callers ?? []);
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  function toggle(slug: string, on: boolean) {
    setSelected(on ? [...selected, slug] : selected.filter((s) => s !== slug));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors([]);
    try {
      await patch.mutateAsync({ etag: app.etag, body: { call: { allowed_callers: selected } } });
      toast.success(t("callers.saved"));
    } catch (err) {
      setErrors(unmappedErrors(fieldErrorsOf(err), []));
    }
  }

  return (
    <Section id="callers" title={t("callers.title")} description={t("callers.description")}>
      {apps.isError ? (
        <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle={t("callers.notFound")} />
      ) : apps.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label={t("callers.formLabel")}>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">{t("callers.legend")}</legend>
            {(apps.data ?? [])
              .filter((a) => a.slug !== app.slug)
              .map((a) => (
                <label key={a.slug} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={selected.includes(a.slug)}
                    onChange={(e) => toggle(a.slug, e.target.checked)}
                  />
                  {a.slug}
                </label>
              ))}
          </fieldset>
          {(apps.data ?? []).length <= 1 ? (
            <p className="text-sm text-muted">{t("callers.none")}</p>
          ) : null}
          <FormAlert messages={errors} />
          <p className="text-sm text-muted">{t("replaceNote")}</p>
          <div>
            <SaveButton disabled={patch.isPending}>
              {t("callers.save")}
            </SaveButton>
          </div>
        </form>
      )}
    </Section>
  );
}
