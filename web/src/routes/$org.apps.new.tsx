import { useState, type FormEvent } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";

import { AuthForm, FormField } from "@/components/auth/auth-form";
import { TEMPLATES } from "@/components/features/empty/no-apps";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useCreateApp, useEnvironments, useProjects, type Template } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";
import { handleMutationError } from "@/lib/query";
import { cn } from "@/lib/utils";
import { toast } from "sonner";

type NewAppSearch = { project?: string };

export const Route = createFileRoute("/$org/apps/new")({
  validateSearch: (search: Record<string, unknown>): NewAppSearch => ({
    project: typeof search.project === "string" ? search.project : undefined,
  }),
  component: NewAppPage,
});

// NewAppPage creates an app. The environment list comes from the chosen project, so an app can
// only be created into an environment the project defines.
function NewAppPage() {
  const { org } = Route.useParams();
  const { project: initialProject } = Route.useSearch();
  const navigate = useNavigate();
  const projects = useProjects(org);
  const create = useCreateApp(org);

  const [projectChoice, setProjectChoice] = useState(initialProject ?? "");
  const project = projectChoice || projects.data?.[0]?.slug || "";
  const envs = useEnvironments(org, project);

  const [envChoice, setEnvChoice] = useState("");
  const environment = envs.data?.includes(envChoice) ? envChoice : (envs.data?.[0] ?? "");

  const [template, setTemplate] = useState<Template>("http");
  const [errors, setErrors] = useState<Record<string, string>>({});
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const next: Record<string, string> = {};
    if (!project) next.project = "Choose a project.";
    if (!environment) next.environment = "Choose an environment.";
    if (!slug) next.slug = "Enter an app name.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    create.mutate(
      { project, environment, slug, template, name: name || undefined },
      {
        onSuccess: (app) => {
          void navigate({ to: "/$org/apps/$app", params: { org, app: app.slug } });
        },
        onError: (err) => {
          if (!(err instanceof ApiError)) {
            toast.error("Could not create the app. Try again.");
            return;
          }
          if (err.code === "slug_taken") setErrors({ slug: "This app name is taken on this runtime." });
          else if (Object.keys(err.fieldErrors()).length > 0) setErrors(err.fieldErrors());
          else handleMutationError(err);
        },
      },
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">New app</h1>
        <p className="mt-1 text-sm text-muted">Pick a template, then name the app and choose where it runs.</p>
      </div>

      <AuthForm errors={errors} onSubmit={onSubmit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="project">Project</Label>
            <select
              id="project"
              name="project"
              value={project}
              onChange={(e) => {
                setProjectChoice(e.target.value);
                setEnvChoice("");
              }}
              className="h-9 rounded-[8px] border border-line-strong bg-surface px-3 text-sm"
            >
              {(projects.data ?? []).map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
            {errors.project ? <p className="text-sm text-danger">{errors.project}</p> : null}
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="environment">Environment</Label>
            <select
              id="environment"
              name="environment"
              aria-label="Environment"
              value={environment}
              onChange={(e) => setEnvChoice(e.target.value)}
              aria-invalid={errors.environment ? true : undefined}
              className="h-9 rounded-[8px] border border-line-strong bg-surface px-3 text-sm"
            >
              {(envs.data ?? []).map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            {errors.environment ? <p className="text-sm text-danger">{errors.environment}</p> : null}
          </div>
        </div>

        <FormField label="App name" name="slug" error={errors.slug} hint="Lowercase letters, digits and dashes." autoComplete="off" />
        <FormField label="Display name (optional)" name="name" autoComplete="off" />

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Template</legend>
          <div role="radiogroup" aria-label="Template" className="grid gap-2 sm:grid-cols-2">
            {TEMPLATES.map(({ id, title, blurb, Icon }) => {
              const checked = template === id;
              return (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  onClick={() => setTemplate(id)}
                  className={cn(
                    "flex items-start gap-3 rounded-[10px] border bg-surface p-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-focus",
                    checked ? "border-blue ring-1 ring-blue" : "border-line hover:border-line-strong",
                  )}
                >
                  <Icon className="mt-0.5 size-4 text-muted" aria-hidden="true" />
                  <span>
                    <span className="block text-sm font-medium">{title}</span>
                    <span className="block text-sm text-muted">{blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <div className="flex justify-end">
          <Button type="submit" disabled={create.isPending || !project}>
            Create app
          </Button>
        </div>
      </AuthForm>
    </div>
  );
}
