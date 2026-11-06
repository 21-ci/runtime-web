import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useIsInstanceAdmin } from "./gate";

export interface UpdateItem {
  component: "runtime" | "runtime_web";
  repo: string;
  current: string | null;
  latest: string | null;
  outdated: boolean;
  check_failed: boolean;
  check_error?: string | null;
  notes_url: string | null;
  commands: { bare: string; docker: string | null } | null;
}

export interface Updates {
  enabled: boolean;
  checked_at: number | null;
  items: UpdateItem[];
}

const KEY = ["admin", "updates"];
const HOUR_MS = 3_600_000;

function useUpdates() {
  const isAdmin = useIsInstanceAdmin();
  // The server's answer changes at most every six hours, and this runs on every page through the sidebar.
  return useQuery({
    queryKey: KEY,
    queryFn: () => api.get<Updates>("/admin/updates"),
    enabled: isAdmin,
    staleTime: HOUR_MS,
    retry: false,
  });
}

// UpdateNotice is the sidebar row for instance admins. It renders nothing unless a release is newer.
export function UpdateNotice() {
  const { t } = useTranslation("admin");
  const updates = useUpdates();
  const [open, setOpen] = useState(false);
  const outdated = updates.data?.items.filter((i) => i.outdated) ?? [];
  // A failed check is no alarm: one network blip would stay here for six hours. Settings reports it.
  if (outdated.length === 0) return null;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-7 min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm font-medium text-text outline-none hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus"
      >
        <ArrowUpCircle className="size-4 shrink-0 text-accent" aria-hidden="true" />
        <span className="truncate">{t("updates.available")}</span>
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("updates.available")}</DialogTitle>
            <DialogDescription>{t("updates.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <div className="flex min-w-0 flex-col gap-6">
            {outdated.map((item) => (
              <UpdateDetails key={item.component} item={item} />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

// CommandBlock keeps the line breaks, so what is copied and what is read are the same commands.
function CommandBlock({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation(["admin", "common"]);

  function copy() {
    const clipboard = typeof navigator !== "undefined" ? navigator.clipboard : undefined;
    if (!clipboard) {
      toast.error(t("secret.unavailable"));
      return;
    }
    clipboard.writeText(value).then(
      () => toast.success(t("secret.copied", { label })),
      () => toast.error(t("secret.failed")),
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[13px] font-medium">{label}</p>
        <Button variant="secondary" onClick={copy} aria-label={t("secret.copyLabel", { label: label.toLowerCase() })}>
          <Copy aria-hidden="true" />
          {t("common:copy")}
        </Button>
      </div>
      <pre className="overflow-x-auto rounded-sm border border-line-strong bg-panel px-3 py-2 font-mono text-[13px]">{value}</pre>
    </div>
  );
}

function UpdateDetails({ item }: { item: UpdateItem }) {
  const { t } = useTranslation("admin");
  const web = item.component === "runtime_web";
  return (
    <section className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold">{t(web ? "updates.runtimeWeb" : "updates.runtime")}</h3>
        <span className="text-sm tabular-nums text-muted">
          {t("updates.versions", { current: item.current ?? t("updates.unknownVersion"), latest: item.latest })}
        </span>
        {item.notes_url ? (
          <a href={item.notes_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm underline">
            {t("updates.notes")}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ) : null}
      </div>
      <p className="text-sm text-muted">{t(web ? "updates.sameFlags" : "updates.runtimeCaution")}</p>
      {item.commands ? <CommandBlock label={t("updates.bare")} value={item.commands.bare} /> : null}
      {item.commands?.docker ? (
        <CommandBlock label={t("updates.docker")} value={item.commands.docker} />
      ) : (
        <p className="text-sm text-muted">{t("updates.dockerBundled")}</p>
      )}
    </section>
  );
}

function checkFailureKey(error: string | null | undefined) {
  if (error === "network") return { key: "updates.failedNetwork", status: undefined } as const;
  if (error === "bad_response") return { key: "updates.failedResponse", status: undefined } as const;
  const status = /^http_(\d+)$/.exec(error ?? "")?.[1];
  if (status === "403" || status === "429") return { key: "updates.failedLimit", status } as const;
  if (status) return { key: "updates.failedStatus", status } as const;
  return { key: "updates.checkFailed", status: undefined } as const;
}

// UpdatesSection is the toggle on the instance settings page.
export function UpdatesSection() {
  const { t, i18n } = useTranslation("admin");
  const qc = useQueryClient();
  const updates = useUpdates();
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.put<Updates>("/admin/updates", { enabled }),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const check = useMutation({
    mutationFn: () => api.post<Updates>("/admin/updates/check"),
    onSuccess: (data) => qc.setQueryData(KEY, data),
  });
  const data = updates.data;
  if (!data) return null;
  const failure = data.items.find((i) => i.check_failed);
  const reason = failure ? checkFailureKey(failure.check_error) : null;

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-line p-4">
      <h2 className="text-sm font-semibold">{t("updates.sectionTitle")}</h2>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          role="switch"
          checked={data.enabled}
          disabled={save.isPending}
          onChange={(e) => save.mutate(e.target.checked)}
          className="size-4"
        />
        {t("updates.toggle")}
      </label>
      <p className="text-[13px] text-muted">{t("updates.toggleHint")}</p>
      <p className="text-[13px] text-muted">
        {data.checked_at
          ? t("updates.lastChecked", { when: new Date(data.checked_at).toLocaleString(i18n.language) })
          : t("updates.neverChecked")}
      </p>
      {reason ? (
        <p role="status" className="text-[13px] text-muted">
          {t(reason.key, { status: reason.status })}
        </p>
      ) : null}
      {data.enabled ? (
        <div>
          <Button size="sm" variant="secondary" disabled={check.isPending} onClick={() => check.mutate()}>
            {check.isPending ? t("updates.checking") : t("updates.checkNow")}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
