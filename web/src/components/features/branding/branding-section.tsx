import { useRef, useState, type DragEvent, type FormEvent } from "react";
import { AlertTriangle, ImageUp, Trash2 } from "lucide-react";
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

const RADIUS_OPTIONS: { value: Radius; label: string }[] = [
  { value: "sharp", label: "Sharp" },
  { value: "default", label: "Default" },
  { value: "round", label: "Round" },
];
const TINT_OPTIONS: { value: Tint; label: string }[] = [
  { value: "neutral", label: "Neutral" },
  { value: "warm", label: "Warm" },
  { value: "cool", label: "Cool" },
];

const FIELD_MESSAGES: Record<string, string> = {
  too_long: "Too long.",
  must_be_hex: "Use a hex colour like #7c3aed.",
  must_be_http_url: "Use an http or https URL.",
  must_be_email: "Use an email address.",
  invalid_characters: "Remove control characters.",
  unsupported_image: "Use a PNG, JPEG, WebP, ICO or SVG file.",
  svg_active_content: "This SVG contains scripts, event handlers or external references. Export a plain SVG.",
};

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
  return (
    <section aria-labelledby="branding-heading" className="flex max-w-5xl min-w-0 flex-col gap-4">
      <div>
        <h2 id="branding-heading" className="text-[15px] font-semibold">
          Branding
        </h2>
        <p className="text-sm text-muted">Your product name, logo and colour on every page, including sign-in.</p>
      </div>
      {branding.isError ? (
        <QueryError error={branding.error} onRetry={() => void branding.refetch()} notFoundTitle="Branding not available" />
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
  const [draft, setDraft] = useState<BrandingWrite>(() => fromBranding(branding));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmReset, setConfirmReset] = useState(false);

  const set = <K extends keyof BrandingWrite>(k: K, v: BrandingWrite[K]) => setDraft((d) => ({ ...d, [k]: v }));

  function onError(err: unknown, fallback: string) {
    if (err instanceof ApiError && err.code === "stale") {
      toast.error("Branding was changed by someone else. The latest version is loaded.");
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
          toast.success("Branding saved.");
        },
        onError: (err) => onError(err, "Could not save the branding. Try again."),
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
          toast.success("Branding reset to the defaults.");
        },
        onError: (err) => {
          setConfirmReset(false);
          onError(err, "Could not reset the branding. Try again.");
        },
      },
    );
  }

  const accentValid = isHex(draft.accent);
  const derived = accentValid ? deriveAccent(draft.accent) : null;
  const msg = (k: string) => (errors[k] ? (FIELD_MESSAGES[errors[k]] ?? errors[k]) : null);

  return (
    <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <form aria-label="Branding" onSubmit={onSubmit} noValidate className="flex min-w-0 flex-col gap-5">
        <TextField id="brand-name" label="Product name" value={draft.product_name} placeholder={DEFAULT_PRODUCT_NAME} max={40}
          hint="Shown in the sidebar, the sign-in pages and the browser tab." error={msg("product_name")} onChange={(v) => set("product_name", v)} />

        <div className="grid gap-4 sm:grid-cols-3">
          <AssetPicker kind="logo-light" label="Logo" hint="Wide logo for light mode." url={branding.logo_light_url} branding={branding} onStale={onStale} />
          <AssetPicker kind="logo-dark" label="Logo for dark mode" hint="Optional. Falls back to the logo." url={branding.logo_dark_url} branding={branding} onStale={onStale} />
          <AssetPicker kind="icon" label="Icon" hint="Square. Used as the favicon." url={branding.icon_url} branding={branding} onStale={onStale} />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="brand-accent">Accent colour</Label>
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Pick accent colour"
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
                Use default
              </Button>
            ) : null}
          </div>
          <p id="brand-accent-hint" className="text-sm text-muted">
            Buttons, links and focus rings. Hover and dark-mode shades are derived for you.
          </p>
          {msg("accent") || (draft.accent && !accentValid) ? (
            <p className="text-sm text-danger-text">{msg("accent") ?? FIELD_MESSAGES.must_be_hex}</p>
          ) : null}
          {derived?.adjusted ? (
            <p role="status" className="flex items-start gap-1.5 rounded-md bg-tag-yellow-bg px-2 py-1.5 text-sm text-tag-yellow-text">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
              <span>
                {draft.accent} has a contrast of {contrast(draft.accent, "#ffffff").toFixed(1)}:1 on white, below the 4.5:1 WCAG AA
                minimum. Light mode will use the darker {derived.light.accent} instead.
              </span>
            </p>
          ) : null}
        </div>

        <ChoiceGroup label="Corners" name="radius" options={RADIUS_OPTIONS} value={draft.radius} onChange={(v) => set("radius", v)} />
        <ChoiceGroup label="Neutral tint" name="tint" options={TINT_OPTIONS} value={draft.tint} onChange={(v) => set("tint", v)} />

        <TextField id="brand-headline" label="Sign-in headline" value={draft.login_headline} placeholder="Welcome back" max={80}
          error={msg("login_headline")} onChange={(v) => set("login_headline", v)} />
        <TextField id="brand-subtitle" label="Sign-in subtitle" value={draft.login_subtitle} placeholder="Sign in to your workspace." max={160}
          error={msg("login_subtitle")} onChange={(v) => set("login_subtitle", v)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField id="brand-support-url" label="Support URL" value={draft.support_url} placeholder="https://help.example.com" max={300}
            hint="Shown as Get help in the account menu." error={msg("support_url")} onChange={(v) => set("support_url", v)} type="url" />
          <TextField id="brand-support-email" label="Support email" value={draft.support_email} placeholder="support@example.com" max={254}
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
          Hide “Powered by Runtime Web”
        </label>

        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="default" disabled={save.isPending}>
            Save branding
          </Button>
          <Button type="button" variant="secondary" onClick={() => setConfirmReset(true)}>
            Reset to defaults
          </Button>
        </div>
      </form>

      <div className="flex min-w-0 flex-col gap-2">
        <p className="text-[13px] font-medium">Preview</p>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          {(["light", "dark"] as const).map((t) => (
            <BrandPreview
              key={t}
              theme={t}
              draft={draft}
              assets={{ logoLight: branding.logo_light_url, logoDark: branding.logo_dark_url, icon: branding.icon_url }}
            />
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="Reset branding?"
        description="The product name, images, colour and sign-in text go back to the defaults. Uploaded images are deleted."
        confirmLabel="Reset branding"
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
  label: string; name: string; options: { value: T; label: string }[]; value: T; onChange: (v: T) => void;
}) {
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
            {o.label}
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
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = `brand-${kind}`;

  function fail(err: unknown) {
    if (err instanceof ApiError && err.code === "stale") {
      toast.error("Branding was changed by someone else. The latest version is loaded.");
      onStale();
    } else if (err instanceof ApiError && err.status === 413) {
      setError("The image is larger than 512 KB.");
    } else if (err instanceof ApiError && err.fieldErrors().data) {
      const code = err.fieldErrors().data ?? "";
      setError(FIELD_MESSAGES[code] ?? "This image cannot be used.");
    } else {
      setError("Could not upload the image. Try again.");
    }
  }

  async function pick(file: File | undefined) {
    if (!file) return;
    setError(null);
    if (file.size > MAX_ASSET_BYTES) {
      setError("The image is larger than 512 KB.");
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
          <img src={url} alt={`${label} preview`} className="max-h-12 max-w-full object-contain" />
        ) : (
          <ImageUp className="size-5 text-muted" aria-hidden="true" />
        )}
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" disabled={upload.isPending} onClick={() => input.current?.click()}>
            {url ? "Replace" : "Choose file"}
          </Button>
          {url ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${label.toLowerCase()}`}
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
        {hint} PNG, JPEG, WebP, ICO or SVG, up to 512 KB. Drop a file or choose one.
      </p>
      {error ? <p role="alert" className="text-sm text-danger-text">{error}</p> : null}
    </div>
  );
}
