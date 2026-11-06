import { useState, type FormEvent, type KeyboardEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { TEMPLATES } from "@/components/features/empty/no-apps";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateApp, useEnvironments, useProjects, type Template } from "@/hooks/orgs";
import { ApiError, getCsrfToken } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";
import { handleMutationError } from "@/lib/query";
import { isBranchEnvironment, slugError } from "@/lib/slug";
import { cn } from "@/lib/utils";
import { IconTile, type Hue } from "@/components/ui/icon-tile";
import { PageHeader } from "@/components/ui/page-header";
import { Cpu, Plus } from "lucide-react";

type Kind = Template | "wasm";
const KIND_HUE: Record<Kind, Hue> = { http: "blue", cron: "pink", queue: "orange", "sqlite-crud": "teal", wasm: "purple" };
const KINDS = [...TEMPLATES, { id: "wasm", titleKey: "new.wasm.title", blurbKey: "new.wasm.blurb", Icon: Cpu }] as const;
import { toast } from "sonner";

type NewAppSearch = { project?: string };

// A raw body: the api helper only sends JSON.
async function uploadWasm(org: string, b: { project: string; environment: string; slug: string; name: string }, file: File) {
  const q = new URLSearchParams({ project: b.project, environment: b.environment, slug: b.slug, ...(b.name ? { name: b.name } : {}) });
  const csrf = getCsrfToken();
  const res = await fetch(`/api/orgs/${encodeURIComponent(org)}/apps/wasm?${q.toString()}`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/wasm", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
    body: file,
  });
  const body = (await res.json().catch(() => ({}))) as { slug?: string; error?: { code?: string; message?: string; details?: Record<string, unknown> } };
  if (!res.ok) throw new ApiError(res.status, body.error?.code ?? "unknown", body.error?.message ?? res.statusText, body.error?.details);
  return { slug: body.slug ?? b.slug };
}

export const Route = createFileRoute("/$org/apps/new")({
  validateSearch: (search: Record<string, unknown>): NewAppSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: NewAppPage,
});

// NewAppPage creates an app. The environment list comes from the chosen project, so an app can
// only be created into an environment the project defines.
function NewAppPage() {
  const { t } = useTranslation(["apps", "common", "operator"]);
  const { org } = Route.useParams();
  const { project: initialProject } = Route.useSearch();
  const navigate = useNavigate();
  const projects = useProjects(org);
  const create = useCreateApp(org);

  const [projectChoice, setProjectChoice] = useState(initialProject ?? "");
  const project = projectChoice || projects.data?.[0]?.slug || "";
  const envs = useEnvironments(org, project);

  const [envChoice, setEnvChoice] = useState("");
  // A branch's environment goes away with the branch, so it is never the default.
  const environment = envs.data?.includes(envChoice) ? envChoice : (envs.data?.find((e) => !isBranchEnvironment(e)) ?? envs.data?.[0] ?? "");
  const [slugText, setSlugText] = useState("");
  const liveSlugError = slugError(slugText.trim());

  const [template, setTemplate] = useState<Kind>("http");
  const [wasm, setWasm] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  // Why Create is unavailable, shown next to it instead of a silently disabled button.
  const disabledReason = projects.isPending
    ? t("new.loadingProjects")
    : !project
      ? t("new.noProjects")
      : envs.isPending
        ? t("new.loadingEnvironments")
        : envs.data && envs.data.length === 0
          ? t("new.noEnvironments")
          : null;
  const [errors, setErrors] = useState<Record<string, string>>({});
  function onKindKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = (KINDS.findIndex((k) => k.id === template) + step + KINDS.length) % KINDS.length;
    setTemplate(KINDS[next]!.id);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const next: Record<string, string> = {};
    if (!project) next.project = t("new.chooseProject");
    if (!environment) next.environment = t("new.chooseEnvironment");
    if (!slug) next.slug = t("new.enterName");
    else if (liveSlugError) next.slug = liveSlugError;
    if (template === "wasm" && !wasm) next.file = t("new.wasm.required");
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    if (template === "wasm") {
      if (!wasm) return;
      setUploading(true);
      void uploadWasm(org, { project, environment, slug, name }, wasm)
        .then((app) => navigate({ to: "/$org/apps/$app", params: { org, app: app.slug } }))
        .catch((err: unknown) => {
          if (err instanceof ApiError && err.code === "slug_taken") setErrors({ slug: t("new.slugTaken") });
          else setErrors({ file: err instanceof ApiError && err.fieldErrors().file ? t("operator:wasm.notWasm") : errorMessage(err) });
        })
        .finally(() => setUploading(false));
      return;
    }

    create.mutate(
      { project, environment, slug, template, name: name || undefined },
      {
        onSuccess: (app) => {
          void navigate({ to: "/$org/apps/$app", params: { org, app: app.slug } });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) {
            toast.error(t("new.failed"));
            return;
          }
          if (err.code === "slug_taken") setErrors({ slug: t("new.slugTaken") });
          else if (err.fieldErrors().slug === "pattern") setErrors({ slug: t("new.slugPattern") });
          else if (Object.keys(err.fieldErrors()).length > 0) setErrors(err.fieldErrors());
          else handleMutationError(err);
        },
      },
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <PageHeader icon={Plus} entity="apps" title={t("new.title")} description={t("new.description")} />

      <AuthForm errors={errors} onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project">{t("new.project")}</Label>
            <Select
              name="project"
              value={project}
              onValueChange={(v) => {
                setProjectChoice(v);
                setEnvChoice("");
              }}
            >
              <SelectTrigger id="project" className="h-9 px-3 text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(projects.data ?? []).map((p) => (
                  <SelectItem key={p.slug} value={p.slug}>
                    {p.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {errors.project ? <p className="text-sm text-danger">{errors.project}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="environment">{t("new.environment")}</Label>
            <Select name="environment" value={environment} onValueChange={setEnvChoice} disabled={envs.isPending && project !== ""}>
              <SelectTrigger
                id="environment"
                aria-label={t("new.environment")}
                aria-invalid={errors.environment ? true : undefined}
                aria-busy={envs.isPending && project !== "" ? true : undefined}
                className="h-9 px-3 text-sm"
              >
                <SelectValue placeholder={envs.isPending && project !== "" ? t("new.loadingEnvironments") : undefined} />
              </SelectTrigger>
              <SelectContent>
                {(envs.data ?? []).map((e) => (
                  <SelectItem key={e} value={e}>
                    {isBranchEnvironment(e) ? t("new.branchEnvironment", { environment: e }) : e}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {isBranchEnvironment(environment) ? <p className="text-sm text-muted">{t("new.branchEnvironmentHint")}</p> : null}
            {errors.environment ? <p className="text-sm text-danger">{errors.environment}</p> : null}
          </div>
        </div>

        <FormField
          label={t("new.appName")}
          name="slug"
          value={slugText}
          onChange={(e) => {
            setSlugText(e.target.value);
            if (errors.slug) setErrors((prev) => Object.fromEntries(Object.entries(prev).filter(([k]) => k !== "slug")));
          }}
          error={errors.slug ?? liveSlugError ?? undefined}
          hint={t("new.appNameHint")}
          autoComplete="off"
        />
        <FormField label={t("new.displayName")} name="name" autoComplete="off" />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">{t("new.template")}</legend>
          <div role="radiogroup" aria-label={t("new.template")} onKeyDown={onKindKey} className="grid gap-2 sm:grid-cols-2">
            {KINDS.map(({ id, titleKey, blurbKey, Icon }) => {
              const checked = template === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  tabIndex={checked ? 0 : -1}
                  onClick={() => setTemplate(id)}
                  className={cn(
                    "flex h-full min-w-0 items-center gap-3 rounded-lg border bg-surface p-3 text-left shadow-card outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus",
                    checked ? "border-accent ring-1 ring-accent" : "border-line hover:border-line-strong",
                  )}
                >
                  <IconTile icon={Icon} hue={KIND_HUE[id]} size="md" solid />
                  <span className="min-w-0">
                    <span className="block break-words text-sm font-medium">{t(titleKey)}</span>
                    <span className="block break-words text-sm text-muted">{t(blurbKey)}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        {template === "wasm" ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="wasm-file">{t("new.wasm.file")}</Label>
            <input
              id="wasm-file"
              type="file"
              accept=".wasm,application/wasm"
              className="text-sm"
              aria-invalid={errors.file ? true : undefined}
              onChange={(e) => setWasm(e.target.files?.[0] ?? null)}
            />
            {errors.file ? <p role="alert" className="text-sm text-danger">{errors.file}</p> : null}
            <p className="text-xs text-muted">{t("operator:wasm.cli")} <code className="break-all font-mono">21ci push --service &lt;app&gt; component.wasm</code></p>
          </div>
        ) : null}

        <p className="text-sm text-muted">{t("operator:gitAfterCreate")}</p>

        <div className="flex flex-wrap items-center justify-end gap-3">
          {disabledReason ? (
            <p id="create-disabled-reason" className="text-sm text-muted">
              {disabledReason}
            </p>
          ) : null}
          <Button
            type="submit"
            variant="default"
            disabled={create.isPending || uploading || disabledReason !== null}
            aria-describedby={disabledReason ? "create-disabled-reason" : undefined}
          >
            {t("new.create")}
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}
