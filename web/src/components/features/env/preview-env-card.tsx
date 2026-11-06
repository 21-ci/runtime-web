import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { KeyValueRows, objectFromRows, type KvRow } from "@/components/ui/key-value-rows";
import { SectionCard } from "@/components/ui/section-card";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";

// PreviewEnvCard edits the variables preview apps receive. canWrite false says so; the values are not read.
export function PreviewEnvCard({ org, app, canWrite }: { org: string; app: string; canWrite: boolean }) {
  const { t } = useTranslation("env");
  return (
    <SectionCard title={t("previewEnv.title")} description={t("previewEnv.description")}>
      {canWrite ? <Editor org={org} app={app} /> : <EmptyState variant="permission" title={t("previewEnv.permission")} />}
    </SectionCard>
  );
}

function Editor({ org, app }: { org: string; app: string }) {
  const { t } = useTranslation("env");
  const qc = useQueryClient();
  const path = `/orgs/${encodeURIComponent(org)}/apps/${encodeURIComponent(app)}/preview-env`;
  const key = ["preview-env", org, app];
  // draft holds the rows once the user edits them; until then the saved variables are shown.
  const [draft, setDraft] = useState<KvRow[] | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<number, string>>({});
  const env = useQuery({ queryKey: key, queryFn: () => api.get<{ env: Record<string, string> }>(path) });
  const save = useMutation({
    mutationFn: (v: Record<string, string>) => api.put<null>(path, { env: v }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: key });
      setDraft(null);
      toast.success(t("previewEnv.saved"));
    },
  });

  if (env.isError) return <QueryError error={env.error} onRetry={() => void env.refetch()} notFoundTitle={t("previewEnv.notFound")} />;
  if (env.isPending) return <Skeleton className="h-16 w-full" />;

  const rows = draft ?? Object.entries(env.data.env).map(([k, value]) => ({ key: k, value }));
  function onSave() {
    const built = objectFromRows(
      rows,
      { keyRequired: t("previewEnv.rowKeyRequired"), valueRequired: t("previewEnv.rowValueRequired"), duplicateKey: t("previewEnv.rowDuplicateKey") },
      { typed: false, allowEmpty: true },
    );
    if ("errors" in built) {
      setRowErrors(built.errors);
      return;
    }
    setRowErrors({});
    save.mutate(built.value as Record<string, string>);
  }
  return (
    <div className="flex flex-col gap-3">
      <KeyValueRows
        idPrefix="preview-env-card"
        rows={rows}
        onChange={setDraft}
        errors={rowErrors}
        labels={{
          key: t("previewEnv.key"),
          value: t("previewEnv.value"),
          add: t("previewEnv.add"),
          remove: (k) => t("previewEnv.remove", { key: k }),
          keyPlaceholder: "NAME",
        }}
      />
      <div>
        <Button size="sm" variant="secondary" disabled={save.isPending} onClick={onSave}>
          {t("previewEnv.save")}
        </Button>
      </div>
    </div>
  );
}
