import { useNavigate } from "@tanstack/react-router";
import { CircleUser, LogOut } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLogout } from "@/hooks/auth";

// AccountMenu holds sign-out. Logout clears the in-memory CSRF token (useLogout) even when the
// request fails, then sends the user to the login page.
export function AccountMenu() {
  const logout = useLogout();
  const navigate = useNavigate();

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
          <CircleUser className="size-5" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} disabled={logout.isPending}>
          <LogOut className="size-4" aria-hidden="true" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
