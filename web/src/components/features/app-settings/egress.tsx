import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Label } from "@/components/ui/label";
import { ChipInput } from "@/components/ui/chip-input";
import { type AppDetail, usePatchApp } from "./api";
import { FieldError, FormAlert, Section, fieldErrorsOf, SaveButton, unmappedErrors } from "./shared";

const HOST_LISTS = ["allowed_hosts", "denied_hosts"] as const;

// listOf reads a stored host list, tolerating a missing or malformed one as empty.
const listOf = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// hostError finds the server message for one host list: the whole list, or any one of its entries.
function hostError(fields: Record<string, string>, list: string): string | undefined {
  const exact = fields[`egress.${list}`];
  if (exact) return exact;
  const entry = Object.entries(fields).find(([path]) => path.startsWith(`egress.${list}[`));
  return entry?.[1];
}

// EgressSection edits the outbound policy: the hosts the app may reach and the hosts it may not.
// Each list is a set of chips. Other keys the runtime keeps in the block are sent back unchanged.
export function EgressSection({ org, app }: { org: string; app: AppDetail }) {
  const { t } = useTranslation(["app-settings", "common"]);
  const initial: Record<string, unknown> = app.egress ?? {};
  const [allowed, setAllowed] = useState<string[]>(listOf(initial.allowed_hosts));
  const [denied, setDenied] = useState<string[]>(listOf(initial.denied_hosts));
  const [fields, setFields] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const patch = usePatchApp(org, app.slug);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setFields({});
    setErrors([]);
    const body: Record<string, unknown> = { ...initial, allowed_hosts: allowed, denied_hosts: denied };
    try {
      await patch.mutateAsync({ etag: app.etag, body: { egress: body } });
      toast.success(t("egress.saved"));
    } catch (err) {
      const server = fieldErrorsOf(err);
      setFields(server);
      setErrors(unmappedErrors(server, ["egress", ...HOST_LISTS.map((l) => `egress.${l}`)]));
    }
  }

  const sections: { list: (typeof HOST_LISTS)[number]; title: string; value: string[]; set: (v: string[]) => void }[] = [
    { list: "allowed_hosts", title: t("egress.allowed"), value: allowed, set: setAllowed },
    { list: "denied_hosts", title: t("egress.denied"), value: denied, set: setDenied },
  ];

  return (
    <Section id="egress" title={t("egress.title")} description={t("egress.description")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-4" aria-label={t("egress.formLabel")}>
        {sections.map((s) => {
          const id = `egress-${s.list}`;
          const message = hostError(fields, s.list);
          return (
            <div key={s.list} className="flex flex-col gap-1.5">
              <Label htmlFor={id}>{s.title}</Label>
              <ChipInput
                id={id}
                value={s.value}
                onChange={s.set}
                placeholder={t("egress.hostPlaceholder")}
                invalid={Boolean(message)}
                describedBy={message ? `${id}-error` : `${id}-hint`}
              />
              <p id={`${id}-hint`} className="text-[13px] text-muted">
                {t("egress.hostsHint")}
              </p>
              <FieldError id={`${id}-error`} message={message} />
            </div>
          );
        })}
        <FieldError id="egress-error" message={fields.egress} />
        <FormAlert messages={errors} />
        <div>
          <SaveButton disabled={patch.isPending}>{t("egress.save")}</SaveButton>
        </div>
      </form>
    </Section>
  );
}
