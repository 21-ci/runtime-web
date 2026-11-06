import { Languages } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LANGUAGES, isLanguage, setLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";

// LanguageSelect is the small language picker for pages without the account menu (sign-in, setup, invite).
export function LanguageSelect({ className }: { className?: string }) {
  const { t, i18n } = useTranslation("shell");
  const value = isLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  return (
    <div className={cn("inline-flex items-center gap-1.5 text-[13px] text-muted", className)}>
      <Languages className="size-3.5" aria-hidden="true" />
      <Select
        value={value}
        onValueChange={(v) => {
          if (isLanguage(v)) void setLanguage(v);
        }}
      >
        <SelectTrigger aria-label={t("account.language")} className="h-7 w-auto border-transparent bg-transparent px-1.5 text-[13px] text-muted hover:text-text">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map((l) => (
            <SelectItem key={l.code} value={l.code} lang={l.code}>
              {l.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
