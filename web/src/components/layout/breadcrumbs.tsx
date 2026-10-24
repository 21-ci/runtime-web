import { Link, useParams } from "@tanstack/react-router";

import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { OrgAvatar } from "./org-switcher";

const CRUMB =
  "min-w-0 truncate rounded-sm px-1 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus";
const CURRENT = "min-w-0 truncate px-1 text-text";

function Sep() {
  return (
    <span aria-hidden="true" className="shrink-0 text-muted">
      /
    </span>
  );
}

// Breadcrumbs shows org / project / app for the current route. Parents are muted links; the
// last crumb is primary text and carries aria-current. An app's project comes from the apps list.
export function Breadcrumbs({ org }: { org: string }) {
  const params = useParams({ strict: false }) as { p?: string; app?: string };
  const orgs = useOrgs();
  const projects = useProjects(org);
  const apps = useApps(org);

  const orgName = orgs.data?.find((o) => o.slug === org)?.name ?? org;
  const app = params.app && params.app !== "new" ? (apps.data ?? []).find((a) => a.slug === params.app) : undefined;
  const projectSlug = params.p ?? app?.project;
  const project = projectSlug ? (projects.data ?? []).find((p) => p.slug === projectSlug) : undefined;
  const appLabel = params.app && params.app !== "new" ? (app?.name ?? params.app) : undefined;

  const last = appLabel ? "app" : projectSlug ? "project" : "org";

  return (
    <nav aria-label="Breadcrumb" className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        <li className="flex min-w-0 items-center gap-1.5">
          <span className="hidden sm:inline-flex">
            <OrgAvatar name={orgName} />
          </span>
          {last === "org" ? (
            <span className={CURRENT} aria-current="page">
              {orgName}
            </span>
          ) : (
            <Link to="/$org" params={{ org }} className={CRUMB}>
              {orgName}
            </Link>
          )}
        </li>
        {projectSlug ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <Sep />
            {last === "project" ? (
              <span className={CURRENT} aria-current="page">
                {project?.name ?? projectSlug}
              </span>
            ) : (
              <Link to="/$org/projects/$p" params={{ org, p: projectSlug }} className={CRUMB}>
                {project?.name ?? projectSlug}
              </Link>
            )}
          </li>
        ) : null}
        {appLabel ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <Sep />
            <span className={CURRENT} aria-current="page">
              {appLabel}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
