import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ApiError } from "@/lib/api";
import { errorMessage } from "@/lib/error-message";

import { useCreateBranch } from "./use-branches";

const NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;

export function NewBranchDialog({ org, app, onClose }: { org: string; app: string; onClose: () => void }) {
  const { t } = useTranslation(["operator", "common", "branches"]);
  const create = useCreateBranch(org, app);
  const [name, setName] = useState("");
  const [parentCode, setParentCode] = useState(true);
  const [copyData, setCopyData] = useState(false);
  const [days, setDays] = useState("");
  const [isPublic, setIsPublic] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameBad = name !== "" && (!NAME_RE.test(name) || name.includes("--"));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name || nameBad) {
      setError(t("branch.namePattern"));
      return;
    }
    setError(null);
    create.mutate(
      {
        name,
        copy_data: copyData,
        parent_code: parentCode,
        access: isPublic && !copyData ? "public" : "key",
        ...(days ? { expires_in_days: Number(days) } : {}),
      },
      {
        onSuccess: onClose,
        onError: (err) => {
          const fields = err instanceof ApiError ? err.fieldErrors() : {};
          const unbuilt = err instanceof ApiError && err.code === "version_not_ready";
          setError(fields.name ? t("branch.namePattern") : unbuilt ? t("branches:parentCodeNotReady") : errorMessage(err));
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("branch.newTitle")}</DialogTitle>
          <DialogDescription>{t("branch.newHint")}</DialogDescription>
        </DialogHeader>
        <form id="new-branch" onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-name">{t("branch.name")}</Label>
            <Input id="branch-name" value={name} autoComplete="off" aria-invalid={nameBad || undefined} onChange={(e) => setName(e.target.value)} />
            <p className="break-all text-xs text-muted">{name && !nameBad ? t("branch.slugWillBe", { slug: `${app}-br-${name}` }) : t("branch.namePattern")}</p>
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={parentCode} onChange={(e) => setParentCode(e.target.checked)} />
            <span>{t("branches:parentCode")}<span className="block text-xs text-muted">{t("branches:parentCodeHint")}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={copyData} onChange={(e) => setCopyData(e.target.checked)} />
            <span>{t("branch.copyData")}<span className="block text-xs text-muted">{t("branch.copyDataHint")}</span></span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={isPublic && !copyData} disabled={copyData} onChange={(e) => setIsPublic(e.target.checked)} />
            <span>{t("branch.public")}<span className="block text-xs text-muted">{t("branch.publicHint")}</span></span>
          </label>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="branch-days">{t("branch.expires")}</Label>
            <Input id="branch-days" type="number" min={1} max={365} value={days} placeholder={t("branch.expiresNever")} onChange={(e) => setDays(e.target.value)} />
          </div>
          {error ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
        </form>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>{t("common:cancel")}</Button>
          <Button type="submit" form="new-branch" disabled={create.isPending}>{t("branch.create")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
