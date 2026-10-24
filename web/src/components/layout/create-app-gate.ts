import { useCan } from "@/hooks/authz";
import { useProjects } from "@/hooks/orgs";

// useCreateAppGate mirrors the app create rule: creating an app in a project needs the developer
// level there; org owners, org admins and instance admins always pass ("org.update" is the
// org-admin probe). It answers false while roles load, so "New app" never flashes.
export function useCreateAppGate(org: string): {
  any: boolean;
  inProject: (project: string) => boolean;
} {
  const projects = useProjects(org);
  const can = useCan(org);
  const orgAdmin = can("org.update") === true;

  function inProject(slug: string): boolean {
    if (orgAdmin) return true;
    const role = projects.data?.find((p) => p.slug === slug)?.role;
    return role === "developer" || role === "admin";
  }

  return {
    any: orgAdmin || (projects.data ?? []).some((p) => inProject(p.slug)),
    inProject,
  };
}
