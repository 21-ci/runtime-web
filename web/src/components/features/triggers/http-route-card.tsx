import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import type { AppView } from "@/components/features/app-header/hooks";
import { SMALL_CONTROL } from "@/components/ui/section-card";

// HttpRouteCard says in one line how the App is reached over HTTP. Editing lives in its settings.
export function HttpRouteCard({ org, app, view }: { org: string; app: string; view: AppView }) {
  const { t } = useTranslation(["triggers", "operator"]);
  const methods = view.ingress?.methods ?? [];
  const paths = view.ingress?.path_prefixes ?? [];
  const pathText = paths.length ? paths.join(", ") : t("operator:triggers.allPaths");
  return (
    <section aria-labelledby="http-heading" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <h2 id="http-heading" className="text-[15px] font-semibold">
        {t("http.title")}
      </h2>
      <p className="flex min-w-0 flex-1 basis-48 flex-wrap gap-x-2 text-sm text-muted">
        <span>{t(`http.accessOptions.${view.access}`, { defaultValue: view.access })}</span>
        <span aria-hidden="true">·</span>
        <span>{methods.length ? methods.join(", ") : t("operator:triggers.allMethods")}</span>
        <span aria-hidden="true">·</span>
        <span className="min-w-0 truncate" title={pathText}>
          {pathText}
        </span>
      </p>
      <Link to="/$org/apps/$app/settings" params={{ org, app }} className={SMALL_CONTROL}>
        {t("http.edit")}
      </Link>
    </section>
  );
}
