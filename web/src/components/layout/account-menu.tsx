import { useNavigate } from "@tanstack/react-router";
import { Check, ChevronDown, LogOut, ShieldCheck } from "lucide-react";

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
import type { Theme } from "@/lib/theme";
import { OrgAvatar } from "./org-switcher";
import { useShell } from "./shell-context";

const THEMES: { value: Theme; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

// AccountMenu holds account security, the theme choice (the header toggle is hidden on phones)
// and sign-out. Logout clears the in-memory CSRF token and the query cache (useLogout) even when
// the request fails, then sends the user to the login page.
export function AccountMenu() {
  const logout = useLogout();
  const navigate = useNavigate();
  const { theme, setTheme } = useShell();
  const me = useMe();
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
        aria-label="Account menu"
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
          Account security
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.value} onSelect={() => setTheme(t.value)} className="justify-between">
            {t.label}
            {theme === t.value ? <Check aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} disabled={logout.isPending}>
          <LogOut aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
