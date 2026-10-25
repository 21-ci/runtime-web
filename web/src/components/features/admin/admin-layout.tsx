import type { ReactNode } from "react";

import { AppShell } from "@/components/layout/app-shell";
import { pickOrg, readLastOrg } from "@/components/layout/last-org";
import { useOrgs } from "@/hooks/orgs";

// AdminLayout renders the instance-admin pages in the same shell as the rest of the console: the
// org switcher, ⌘K, projects and footer stay, and the Instance group in the sidebar marks the
// page. The pages sit outside an org, so the shell keeps the org the user last opened.
export function AdminLayout({ children }: { children: ReactNode }) {
  const orgs = useOrgs();
  return <AppShell org={pickOrg(orgs.data, readLastOrg())}>{children}</AppShell>;
}
