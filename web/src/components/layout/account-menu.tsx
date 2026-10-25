import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, Languages, LifeBuoy, LogOut, Mail, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useBranding } from "@/components/features/branding/hooks";
import { useMe } from "@/components/features/security/hooks";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogout } from "@/hooks/auth";
import { LANGUAGES, currentLanguage, setLanguage } from "@/lib/i18n";
import type { Theme } from "@/lib/theme";
import { OrgAvatar } from "./org-switcher";
import { useShell } from "./shell-context";

const THEMES = [
  { value: "system", labelKey: "account.themeSystem" },
  { value: "light", labelKey: "account.themeLight" },
  { value: "dark", labelKey: "account.themeDark" },
] as const satisfies readonly { value: Theme; labelKey: string }[];

// AccountMenu holds account security, the theme choice (the header toggle is hidden on phones)
// and sign-out. Logout clears the in-memory CSRF token and the query cache (useLogout) even when
// the request fails, then sends the user to the login page.
export function AccountMenu() {
  const logout = useLogout();
  const navigate = useNavigate();
  const { theme, setTheme } = useShell();
  const me = useMe();
  const { data: brand } = useBranding();
  const { t } = useTranslation("shell");
  const language = currentLanguage();
  const name = me.data?.user.name ?? me.data?.user.email ?? "?";
  const email = me.data?.user.email;

  function onLogout() {
    logout.mutate(undefined, {
      onSettled: () => {
        void navigate({ to: "/login" });
      },
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("account.menu")}
        className="ml-1 inline-flex h-8 cursor-pointer items-center gap-1 rounded-md py-0.5 pl-1 pr-1.5 text-muted outline-none transition-colors duration-[120ms] hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus data-[state=open]:bg-hover"
      >
        <OrgAvatar name={name} className="size-6 rounded-full text-[11px]" />
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[220px]">
        <div className="px-2 py-1.5">
          <p className="truncate text-sm font-medium text-text">{name}</p>
          {email && email !== name ? <p className="truncate text-[12px] text-muted">{email}</p> : null}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void navigate({ to: "/me/security" })}>
          <ShieldCheck aria-hidden="true" />
          {t("nav.accountSecurity")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("account.theme")}</DropdownMenuLabel>
        {THEMES.map((o) => (
          <DropdownMenuItem key={o.value} onSelect={() => setTheme(o.value)} className="justify-between">
            {t(o.labelKey)}
            {theme === o.value ? <Check aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="flex items-center gap-1.5">
          <Languages className="size-3.5" aria-hidden="true" />
          {t("account.language")}
        </DropdownMenuLabel>
        {LANGUAGES.map((l) => (
          <DropdownMenuItem
            key={l.code}
            lang={l.code}
            onSelect={() => void setLanguage(l.code)}
            className="justify-between"
          >
            {l.label}
            {language === l.code ? <Check aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        {brand?.support_url || brand?.support_email ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t("account.help")}</DropdownMenuLabel>
            {brand.support_url ? (
              <DropdownMenuItem asChild>
                <a href={brand.support_url} target="_blank" rel="noopener noreferrer">
                  <LifeBuoy aria-hidden="true" />
                  {t("account.getHelp")}
                </a>
              </DropdownMenuItem>
            ) : null}
            {brand.support_email ? (
              <DropdownMenuItem asChild>
                <a href={`mailto:${brand.support_email}`}>
                  <Mail aria-hidden="true" />
                  {t("account.emailSupport")}
                </a>
              </DropdownMenuItem>
            ) : null}
          </>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} disabled={logout.isPending}>
          <LogOut aria-hidden="true" />
          {t("account.logOut")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
