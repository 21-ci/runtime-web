import { useState, type FormEvent, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { AuthForm, FormField } from "@/components/auth/auth-form";
import { useCreateProject } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";

// CreateProjectDialog creates a project with its environments. The default environments match the
// runtime's own defaults; the list is editable as a comma-separated value.
export function CreateProjectDialog({ org, trigger }: { org: string; trigger: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const create = useCreateProject(org);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const environments = String(form.get("environments") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const next: Record<string, string> = {};
    if (!slug) next.slug = "Enter a project name.";
    if (environments.length === 0) next.environments = "Add at least one environment.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate(
      { slug, name: name || undefined, environments },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => {
          if (err instanceof ApiError) setErrors(err.fieldErrors());
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>Projects group apps and set which environments they deploy to.</DialogDescription>
        </DialogHeader>
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label="Slug" name="slug" error={errors.slug} autoComplete="off" />
          <FormField label="Name (optional)" name="name" autoComplete="off" />
          <FormField
            label="Environments"
            name="environments"
            defaultValue="dev, prod"
            hint="Comma-separated, for example dev, staging, prod."
            error={errors.environments}
          />
          <DialogFooter>
            <Button type="submit" disabled={create.isPending}>
              Create project
            </Button>
          </DialogFooter>
        </AuthForm>
      </DialogContent>
    </Dialog>
  );
}
