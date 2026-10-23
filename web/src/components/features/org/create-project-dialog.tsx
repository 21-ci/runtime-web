import { useState, type FormEvent, type ReactNode } from "react";
import { toast } from "sonner";

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
import { handleApiError } from "@/lib/query";

// CreateProjectDialog creates a project with its environments. It is controlled when `open` is
// passed (the ⌘K menu), otherwise it owns its state behind `trigger`. The default environments
// match the runtime's own defaults; the list is editable as a comma-separated value.
export function CreateProjectDialog({
  org,
  trigger,
  open: controlledOpen,
  onOpenChange,
}: {
  org: string;
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
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
          if (!(err instanceof ApiError)) {
            toast.error("Could not create the project. Try again.");
            return;
          }
          const fields = err.fieldErrors();
          if (Object.keys(fields).length > 0) setErrors(fields);
          else handleApiError(err);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
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
