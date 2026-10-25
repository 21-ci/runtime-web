import { Link, useLocation, useParams } from "@tanstack/react-router";
import { ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useApps, useOrgs, useProjects } from "@/hooks/orgs";
import { APP_SECTIONS, INSTANCE_SECTIONS } from "./sidebar";

const CRUMB =
  "min-w-0 truncate rounded-sm px-1 text-muted outline-none hover:bg-hover hover:text-text focus-visible:ring-2 focus-visible:ring-focus";
const CURRENT = "min-w-0 truncate px-1 font-medium text-text";

function Sep() {
  return <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted/70" />;
}

// Breadcrumbs shows org / project / app / section for an org route and Instance / section on an
// instance-admin page. Parents are muted links; the last crumb is primary text and carries
// aria-current.
export function Breadcrumbs({ org }: { org: string | null }) {
  const { pathname } = useLocation();
  if (pathname === "/admin" || pathname.startsWith("/admin/")) return <InstanceCrumbs pathname={pathname} />;
  if (!org) return <div className="flex-1" />;
  return <OrgCrumbs org={org} />;
}

function InstanceCrumbs({ pathname }: { pathname: string }) {
  const section = INSTANCE_SECTIONS.find((s) => pathname.startsWith(s.to));
  const { t } = useTranslation("shell");
  return (
    <nav aria-label={t("breadcrumb.label")} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        <li className="flex min-w-0 items-center">
          {section ? (
            <Link to="/admin/users" className={CRUMB}>
              {t("instance.title")}
            </Link>
          ) : (
            <span className={CURRENT} aria-current="page">
              {t("instance.title")}
            </span>
          )}
        </li>
        {section ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <Sep />
            <span className={CURRENT} aria-current="page">
              {t(section.labelKey)}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}

// OrgCrumbs takes an app's project from the apps list.
function OrgCrumbs({ org }: { org: string }) {
  const params = useParams({ strict: false }) as { p?: string; app?: string };
  const { pathname } = useLocation();
  const orgs = useOrgs();
  const projects = useProjects(org);
  const apps = useApps(org);

  const orgName = orgs.data?.find((o) => o.slug === org)?.name ?? org;
  const appSlug = params.app && params.app !== "new" ? params.app : undefined;
  const app = appSlug ? (apps.data ?? []).find((a) => a.slug === appSlug) : undefined;
  const projectSlug = params.p ?? app?.project;
  const project = projectSlug ? (projects.data ?? []).find((p) => p.slug === projectSlug) : undefined;
  const appLabel = appSlug ? (app?.name ?? appSlug) : undefined;
  const section = appSlug
    ? APP_SECTIONS.find((s) => !s.exact && pathname.startsWith(s.to.replace("$org", org).replace("$app", appSlug)))
    : undefined;

  const { t } = useTranslation("shell");
  const last = section ? "section" : appLabel ? "app" : projectSlug ? "project" : "org";

  return (
    <nav aria-label={t("breadcrumb.label")} className="min-w-0 flex-1">
      <ol className="flex min-w-0 items-center gap-0.5 text-sm">
        <li className="flex min-w-0 items-center">
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
          <li className="hidden min-w-0 items-center gap-0.5 sm:flex">
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
        {appLabel && appSlug ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <Sep />
            {last === "app" ? (
              <span className={CURRENT} aria-current="page">
                {appLabel}
              </span>
            ) : (
              <Link to="/$org/apps/$app" params={{ org, app: appSlug }} className={CRUMB}>
                {appLabel}
              </Link>
            )}
          </li>
        ) : null}
        {section ? (
          <li className="flex min-w-0 items-center gap-0.5">
            <Sep />
            <span className={CURRENT} aria-current="page">
              {t(section.labelKey)}
            </span>
          </li>
        ) : null}
      </ol>
    </nav>
  );
}
