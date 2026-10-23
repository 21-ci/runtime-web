import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";
import { type AppDetail, usePatchApp } from "./api";
import { FormAlert, REPLACE_NOTE, Section, fieldErrorsOf, unmappedErrors } from "./shared";

// CallersSection picks which apps of this org may call this app (call.allowed_callers). The
// picker lists the org's apps, minus this one.
export function CallersSection({ org, app }: { org: string; app: AppDetail }) {
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
      toast.success("Callers saved");
    } catch (err) {
      setErrors(unmappedErrors(fieldErrorsOf(err), []));
    }
  }

  return (
    <Section id="callers" title="Callers" description="Apps in this org that may call this one.">
      {apps.isError ? (
        <QueryError error={apps.error} onRetry={() => void apps.refetch()} notFoundTitle="Apps not found" />
      ) : apps.isPending ? (
        <Skeleton className="h-20 w-full" />
      ) : (
        <form onSubmit={onSubmit} className="flex flex-col gap-3" aria-label="Callers settings">
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">Allowed callers</legend>
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
            <p className="text-sm text-muted">No other apps in this org yet.</p>
          ) : null}
          <FormAlert messages={errors} />
          <p className="text-sm text-muted">{REPLACE_NOTE}</p>
          <div>
            <Button type="submit" disabled={patch.isPending}>
              Save callers
            </Button>
          </div>
        </form>
      )}
    </Section>
  );
}
