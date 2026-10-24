import { createFileRoute } from "@tanstack/react-router";

import { SecurityPage } from "@/components/features/security/security-page";

// Account security is per user, outside any org, so it has no org shell.
export const Route = createFileRoute("/me/security")({
  component: SecurityPage,
});
