import { useNavigate } from "@tanstack/react-router";
import { Check, CircleUser, LogOut, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
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

  function onLogout() {
    logout.mutate(undefined, {
      onSettled: () => {
        void navigate({ to: "/login" });
      },
    });
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Account menu">
          <CircleUser className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[200px]">
        <DropdownMenuItem onSelect={() => void navigate({ to: "/me/security" })}>
          <ShieldCheck className="size-4" aria-hidden="true" />
          Account security
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.value} onSelect={() => setTheme(t.value)} className="justify-between">
            {t.label}
            {theme === t.value ? <Check className="size-4" aria-hidden="true" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} disabled={logout.isPending}>
          <LogOut className="size-4" aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
