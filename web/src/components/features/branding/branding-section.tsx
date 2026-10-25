import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { AlertTriangle, ImageUp, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { QueryError } from "@/components/features/empty/query-error";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

import { contrast, deriveAccent, isHex } from "./color";
import {
  DEFAULT_PRODUCT_NAME,
  MAX_ASSET_BYTES,
  UPSTREAM_NAME,
  useBranding,
  useDeleteBrandAsset,
  useResetBranding,
  useSaveBranding,
  useUploadBrandAsset,
  type AssetKind,
  type Branding,
  type BrandingWrite,
  type Radius,
  type Tint,
} from "./hooks";
import { BrandPreview } from "./preview";

const ACCEPT = "image/png,image/jpeg,image/webp,image/x-icon,image/vnd.microsoft.icon,image/svg+xml,.ico,.svg";
const DEFAULT_ACCENT = "#2563eb";

type ChoiceKey = "radius.sharp" | "radius.default" | "radius.round" | "tint.neutral" | "tint.warm" | "tint.cool";

const RADIUS_OPTIONS: { value: Radius; labelKey: ChoiceKey }[] = [
  { value: "sharp", labelKey: "radius.sharp" },
  { value: "default", labelKey: "radius.default" },
  { value: "round", labelKey: "radius.round" },
];
const TINT_OPTIONS: { value: Tint; labelKey: ChoiceKey }[] = [
  { value: "neutral", labelKey: "tint.neutral" },
  { value: "warm", labelKey: "tint.warm" },
  { value: "cool", labelKey: "tint.cool" },
];

// Server field codes and the message each one shows.
const FIELD_MESSAGES = {
  too_long: "field.tooLong",
  must_be_hex: "field.mustBeHex",
  must_be_http_url: "field.mustBeHttpUrl",
  must_be_email: "field.mustBeEmail",
  invalid_characters: "field.invalidCharacters",
  unsupported_image: "field.unsupportedImage",
  svg_active_content: "field.svgActiveContent",
} as const;
type FieldCode = keyof typeof FIELD_MESSAGES;
const isFieldCode = (code: string): code is FieldCode => Object.prototype.hasOwnProperty.call(FIELD_MESSAGES, code);

const fromBranding = (b: Branding): BrandingWrite => ({
  product_name: b.product_name,
  accent: b.accent,
  login_headline: b.login_headline,
  login_subtitle: b.login_subtitle,
  support_url: b.support_url,
  support_email: b.support_email,
  hide_powered_by: b.hide_powered_by,
  radius: b.radius,
  tint: b.tint,
});

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

// BrandingSection is the white-label editor in instance settings. Text fields save together
// (Save); images upload as soon as they are picked, each write carrying the current etag.
export function BrandingSection() {
  const branding = useBranding();
  const { t } = useTranslation(["branding", "common"]);
  return (
    <section aria-labelledby="branding-heading" className="flex max-w-5xl min-w-0 flex-col gap-4">
      <div>
        <h2 id="branding-heading" className="text-[15px] font-semibold">
          {t("title")}
        </h2>
        <p className="text-sm text-muted">{t("description")}</p>
      </div>
      {branding.isError ? (
        <QueryError error={branding.error} onRetry={() => void branding.refetch()} notFoundTitle={t("unavailable")} />
      ) : branding.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <BrandingForm branding={branding.data} onStale={() => void branding.refetch()} />
      )}
    </section>
  );
}

function BrandingForm({ branding, onStale }: { branding: Branding; onStale: () => void }) {
  const save = useSaveBranding();
  const reset = useResetBranding();
  const { t } = useTranslation(["branding", "common"]);
  const [draft, setDraft] = useState<BrandingWrite>(() => fromBranding(branding));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);

  const set = <K extends keyof BrandingWrite>(k: K, v: BrandingWrite[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function onError(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.code === "stale") {
      toast.error(t("toast.stale"));
      onStale();
    } else if (err instanceof ApiError && Object.keys(err.fieldErrors()).length > 0) {
      setErrors(err.fieldErrors());
    } else {
      toast.error(fallback);
    }
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (draft.accent && !isHex(draft.accent)) {
      setErrors({ accent: "must_be_hex" });
      return;
    }
    setErrors({});
    save.mutate(
      { etag: branding.etag, body: draft },
      {
        onSuccess: (b) => {
          setDraft(fromBranding(b));
          toast.success(t("toast.saved"));
        },
        onError: (err) => onError(err, t("toast.saveFailed")),
      },
    );
  }

  function onReset() {
    reset.mutate(
      { etag: branding.etag },
      {
        onSuccess: (b) => {
          setDraft(fromBranding(b));
          setErrors({});
          setConfirmReset(false);
          toast.success(t("toast.reset"));
        },
        onError: (err) => {
          setConfirmReset(false);
          onError(err, t("toast.resetFailed"));
        },
      },
    );
  }

  const accentValid = isHex(draft.accent);
  const derived = accentValid ? deriveAccent(draft.accent) : null;
  const fieldText = (code: string) => (isFieldCode(code) ? t(FIELD_MESSAGES[code]) : code);
  const msg = (k: string) => (errors[k] ? fieldText(errors[k]) : null);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <form aria-label={t("title")} onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col gap-5">
        <TextField id="brand-name" label={t("fields.productName")} value={draft.product_name} placeholder={DEFAULT_PRODUCT_NAME} max={40}
          hint={t("fields.productNameHint")} error={msg("product_name")} onChange={(v) => set("product_name", v)} />

        <div className="grid gap-4 sm:grid-cols-3">
          <AssetPicker kind="logo-light" label={t("fields.logo")} hint={t("fields.logoHint")} url={branding.logo_light_url} branding={branding} onStale={onStale} />
          <AssetPicker kind="logo-dark" label={t("fields.logoDark")} hint={t("fields.logoDarkHint")} url={branding.logo_dark_url} branding={branding} onStale={onStale} />
          <AssetPicker kind="icon" label={t("fields.icon")} hint={t("fields.iconHint")} url={branding.icon_url} branding={branding} onStale={onStale} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brand-accent">{t("fields.accent")}</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label={t("fields.pickAccent")}
              value={accentValid ? draft.accent : DEFAULT_ACCENT}
              onChange={(e) => set("accent", e.target.value)}
              className="h-9 w-12 cursor-pointer rounded-md border border-line-strong bg-field p-1"
            />
            <Input
              id="brand-accent"
              value={draft.accent}
              placeholder={DEFAULT_ACCENT}
              maxLength={7}
              className="w-32 font-mono"
              aria-invalid={msg("accent") ? true : undefined}
              aria-describedby="brand-accent-hint"
              onChange={(e) => set("accent", e.target.value.trim())}
            />
            {draft.accent ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => set("accent", "")}>
                {t("fields.useDefault")}
              </Button>
            ) : null}
          </div>
          <p id="brand-accent-hint" className="text-sm text-muted">
            {t("fields.accentHint")}
          </p>
          {msg("accent") || (draft.accent && !accentValid) ? (
            <p className="text-sm text-danger-text">{msg("accent") ?? t(FIELD_MESSAGES.must_be_hex)}</p>
          ) : null}
          {derived?.adjusted ? (
            <p role="status" className="flex items-start gap-1.5 rounded-md bg-tag-yellow-bg px-2 py-1.5 text-sm text-tag-yellow-text">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {t("contrast", {
                  color: draft.accent,
                  ratio: contrast(draft.accent, "#ffffff").toFixed(1),
                  adjusted: derived.light.accent,
                })}
              </span>
            </p>
          ) : null}
        </div>

        <ChoiceGroup label={t("fields.corners")} name="radius" options={RADIUS_OPTIONS} value={draft.radius} onChange={(v) => set("radius", v)} />
        <ChoiceGroup label={t("fields.tint")} name="tint" options={TINT_OPTIONS} value={draft.tint} onChange={(v) => set("tint", v)} />

        <TextField id="brand-headline" label={t("fields.headline")} value={draft.login_headline} placeholder={t("defaults.headline")} max={80}
          error={msg("login_headline")} onChange={(v) => set("login_headline", v)} />
        <TextField id="brand-subtitle" label={t("fields.subtitle")} value={draft.login_subtitle} placeholder={t("defaults.subtitle")} max={160}
          error={msg("login_subtitle")} onChange={(v) => set("login_subtitle", v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="brand-support-url" label={t("fields.supportUrl")} value={draft.support_url} placeholder="https://help.example.com" max={300}
            hint={t("fields.supportUrlHint")} error={msg("support_url")} onChange={(v) => set("support_url", v)} type="url" />
          <TextField id="brand-support-email" label={t("fields.supportEmail")} value={draft.support_email} placeholder="support@example.com" max={254}
            error={msg("support_email")} onChange={(v) => set("support_email", v)} type="email" />
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            role="switch"
            name="hide_powered_by"
            checked={draft.hide_powered_by}
            onChange={(e) => set("hide_powered_by", e.target.checked)}
            className="size-4"
          />
          {t("fields.hidePoweredBy", { name: UPSTREAM_NAME })}
        </label>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="default" disabled={save.isPending}>
            {t("actions.save")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => setConfirmReset(true)}>
            {t("actions.reset")}
          </Button>
        </div>
      </form>

      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[13px] font-medium">{t("preview.heading")}</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {(["light", "dark"] as const).map((th) => (
            <BrandPreview
              key={th}
              theme={th}
              draft={draft}
              assets={{ logoLight: branding.logo_light_url, logoDark: branding.logo_dark_url, icon: branding.icon_url }}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title={t("reset.title")}
        description={t("reset.description")}
        confirmLabel={t("reset.confirm")}
        destructive
        pending={reset.isPending}
        onConfirm={onReset}
      />
    </div>
  );
}

function TextField({
  id, label, value, placeholder, max, hint, error, onChange, type = "text",
}: {
  id: string; label: string; value: string; placeholder?: string; max: number; hint?: string; error: string | null;
  onChange: (v: string) => void; type?: string;
}) {
  const describedBy = [hint ? `${id}-hint` : "", error ? `${id}-error` : ""].filter(Boolean).join(" ") || undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} placeholder={placeholder} maxLength={max} aria-invalid={error ? true : undefined}
        aria-describedby={describedBy} onChange={(e) => onChange(e.target.value)} />
      {hint ? <p id={`${id}-hint`} className="text-sm text-muted">{hint}</p> : null}
      {error ? <p id={`${id}-error`} className="text-sm text-danger-text">{error}</p> : null}
    </div>
  );
}

function ChoiceGroup<T extends string>({
  label, name, options, value, onChange,
}: {
  label: string; name: string; options: { value: T; labelKey: ChoiceKey }[]; value: T; onChange: (v: T) => void;
}) {
  const { t } = useTranslation("branding");
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1.5 text-[13px] font-medium">{label}</legend>
      <div className="inline-flex w-fit rounded-md bg-panel-2 p-0.5">
        {options.map((o) => (
          <label
            key={o.value}
            className={cn(
              "cursor-pointer rounded-md px-3 py-1 text-[13px] text-muted has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-focus",
              value === o.value && "bg-surface-2 text-text shadow-card",
            )}
          >
            <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} className="sr-only" />
            {t(o.labelKey)}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function AssetPicker({
  kind, label, hint, url, branding, onStale,
}: {
  kind: AssetKind; label: string; hint: string; url: string | null; branding: Branding; onStale: () => void;
}) {
  const upload = useUploadBrandAsset();
  const remove = useDeleteBrandAsset();
  const { t } = useTranslation(["branding", "common"]);
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `brand-${kind}`;

  function fail(err: unknown) {
    if (err instanceof ApiError && err.code === "stale") {
      toast.error(t("toast.stale"));
      onStale();
    } else if (err instanceof ApiError && err.status === 413) {
      setError(t("asset.tooLarge"));
    } else if (err instanceof ApiError && err.fieldErrors().data) {
      const code = err.fieldErrors().data ?? "";
      setError(isFieldCode(code) ? t(FIELD_MESSAGES[code]) : t("asset.cannotUse"));
    } else {
      setError(t("asset.uploadFailed"));
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_ASSET_BYTES) {
      setError(t("asset.tooLarge"));
      return;
    }
    const data = await readBase64(file);
    upload.mutate({ etag: branding.etag, kind, data }, { onError: fail });
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setOver(false);
    void pick(e.dataTransfer.files[0]);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={onDrop}
        data-testid={`${id}-drop`}
        className={cn(
          // Each logo is shown on the theme it is for, so a dark-text logo stays visible.
          kind === "logo-light" && "light",
          kind === "logo-dark" && "dark",
          "flex h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-line-strong bg-field p-2 text-center text-text",
          over && "border-accent bg-accent-pale",
        )}
      >
        {url ? (
          <img src={url} alt={t("asset.preview", { label })} className="max-h-12 max-w-full object-contain" />
        ) : (
          <ImageUp className="size-5 text-muted" aria-hidden="true" />
        )}
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {url ? t("asset.replace") : t("asset.choose")}
          </Button>
          {url ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("asset.remove", { label: label.toLowerCase() })}
              disabled={remove.isPending}
              onClick={() => remove.mutate({ etag: branding.etag, kind }, { onError: fail })}
            >
              <Trash2 aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <input
          ref={input}
          id={id}
          type="file"
          accept={ACCEPT}
          className="sr-only"
          aria-describedby={`${id}-hint`}
          onChange={(e) => {
            void pick(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>
      <p id={`${id}-hint`} className="text-[12px] text-muted">
        {t("asset.hint", { hint })}
      </p>
      {error ? <p role="alert" className="text-sm text-danger-text">{error}</p> : null}
    </div>
  );
}
