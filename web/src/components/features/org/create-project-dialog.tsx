import { useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
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
import { Label } from "@/components/ui/label";
import { ChipInput } from "@/components/ui/chip-input";
import { useCreateProject } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";
import { handleMutationError } from "@/lib/query";

// CreateProjectDialog creates a project with its environments. It is controlled when `open` is
// passed (the ⌘K menu), otherwise it owns its state behind `trigger`. The default environments
// match the runtime's own defaults; each environment is a chip the user adds and removes.
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
  const { t } = useTranslation(["org", "common"]);
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const setOpen = (next: boolean) => {
    setLocalOpen(next);
    onOpenChange?.(next);
  };
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [environments, setEnvironments] = useState<string[]>(["dev", "prod"]);
  const create = useCreateProject(org);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const slug = String(form.get("slug") ?? "").trim();
    const name = String(form.get("name") ?? "").trim();
    const next: Record<string, string> = {};
    if (!slug) next.slug = t("createProject.errors.slug");
    if (environments.length === 0) next.environments = t("createProject.errors.environments");
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    create.mutate(
      { slug, name: name || undefined, environments },
      {
        onSuccess: () => setOpen(false),
        onError: (err) => {
          if (!(err instanceof ApiError)) {
            toast.error(t("createProject.failed"));
            return;
          }
          const fields = err.fieldErrors();
          if (Object.keys(fields).length > 0) setErrors(fields);
          else handleMutationError(err);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("createProject.title")}</DialogTitle>
          <DialogDescription>{t("createProject.description")}</DialogDescription>
        </DialogHeader>
        <AuthForm errors={errors} onSubmit={onSubmit}>
          <FormField label={t("createProject.slug")} name="slug" error={errors.slug} autoComplete="off" />
          <FormField label={t("createProject.name")} name="name" autoComplete="off" />
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-project-environments">{t("createProject.environments")}</Label>
            <ChipInput
              id="create-project-environments"
              value={environments}
              onChange={setEnvironments}
              placeholder={t("createProject.environmentPlaceholder")}
              invalid={Boolean(errors.environments)}
              describedBy="create-project-environments-hint"
            />
            <p id="create-project-environments-hint" className="text-sm text-muted">
              {t("createProject.environmentsHint")}
            </p>
            {errors.environments ? <p className="text-sm text-danger-text">{errors.environments}</p> : null}
          </div>
          <DialogFooter>
            <Button type="submit" variant="default" disabled={create.isPending}>
              {t("createProject.submit")}
            </Button>
          </DialogFooter>
        </AuthForm>
      </DialogContent>
    </Dialog>
  );
}
