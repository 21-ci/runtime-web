import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { Suspense } from "react";
import { useTranslation } from "react-i18next";

import { AppHeader, AppTabs } from "@/components/features/app-header/app-header";
import { useAppView } from "@/components/features/app-header/hooks";
import { QueryError } from "@/components/features/empty/query-error";
import { PageBody } from "@/components/layout/app-shell";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useApps } from "@/hooks/orgs";
import { ApiError } from "@/lib/api";

export const Route = createFileRoute("/$org/apps/$app")({
  staticData: { fullBleed: true },
  component: AppPage,
});

function PageSkeleton() {
  return (
    <PageBody>
      <div aria-busy="true" className="flex flex-col gap-4">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    </PageBody>
  );
}

// AppPage frames every app sub-page with the app header and tab strip. It asks for the one app directly:
// the org's apps list pages through the whole runtime and is far slower, so it only helps when it wins the
// race (branches are not in it at all). Sub-pages decide their own width through staticData.fullBleed.
function AppPage() {
  const { t } = useTranslation(["apps", "common", "operator"]);
  const { org, app } = Route.useParams();
  const { pathname } = useLocation();
  const apps = useApps(org);
  const view = useAppView(org, app);
  const listed = apps.data?.find((x) => x.slug === app);
  const a = view.data ?? listed;

  if (!a && view.isError && !apps.isPending) {
    const missing = view.error instanceof ApiError && view.error.status === 404;
    return (
      <PageBody>
        {missing ? (
          <EmptyState
            title={t("app.notFound")}
            description={t("notFound.description")}
            action={
              <Button asChild variant="default">
                <Link to="/$org" params={{ org }}>{t("app.backToOrg")}</Link>
              </Button>
            }
          />
        ) : (
          <QueryError error={view.error} onRetry={() => void view.refetch()} notFoundTitle={t("app.notFound")} notFoundDescription={t("notFound.description")} />
        )}
      </PageBody>
    );
  }

  // The code editor fills the viewport, so it gives its height to the code.
  const isEditor = pathname.replace(/\/$/, "").endsWith(`/apps/${app}/code`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {view.data?.branch ? (
        <p role="status" className="border-b border-line bg-surface-2 px-5 py-2 text-sm">
          {t("operator:branch.banner", { name: view.data.branch.name })}{" "}
          <Link to="/$org/apps/$app/branches" params={{ org, app: view.data.branch.parent }} className="underline">
            {view.data.branch.parent}
          </Link>
        </p>
      ) : null}
      {isEditor ? null : <AppHeader org={org} slug={app} app={a} view={view.data} />}
      <AppTabs org={org} slug={app} />
      {/* A sub-page's lazy chunk suspends here, so the header and tabs stay put while it loads. */}
      <Suspense fallback={<PageSkeleton />}>{a ? <Outlet /> : <PageSkeleton />}</Suspense>
    </div>
  );
}
