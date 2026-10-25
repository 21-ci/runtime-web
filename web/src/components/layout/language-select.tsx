import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { LANGUAGES, isLanguage, setLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// LanguageSelect is the small language picker for pages without the account menu (sign-in, setup,
// invite). A native select: it is keyboard and screen-reader friendly with no extra code.
export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation("shell");
  const value = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  return (
    <label className={cn("inline-flex items-center gap-1.5 text-[13px] text-muted", className)}>
      <Languages className="size-3.5" aria-hidden="true" />
      <span className="sr-only">{t("account.language")}</span>
      <select
        value={value}
        onChange={(e) => {
          if (isLanguage(e.target.value)) void setLanguage(e.target.value);
        }}
        className="cursor-pointer rounded-md bg-transparent py-0.5 pr-1 text-[13px] text-muted outline-none hover:text-text focus-visible:ring-2 focus-visible:ring-focus"
      >
        {LANGUAGES.map((l) => (
          <option key={l.code} value={l.code} lang={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
