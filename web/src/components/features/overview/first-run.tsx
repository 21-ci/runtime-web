import { Link } from "@tanstack/react-router";
import { X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { SectionCard } from "@/components/ui/section-card";

const hiddenKey = (org: string, app: string) => `rtweb.first-run.hidden:${org}/${app}`;

function readHidden(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

/** A request that does something for this code: the templates differ in what they answer. */
export function sampleCurl(url: string, source: string, needsToken: boolean): string {
  const base = url.replace(/\/+$/, "");
  const auth = needsToken ? ` -H "Authorization: Bearer $TOKEN"` : "";
  if (source.includes('"/items"')) {
    return `curl${auth} -X POST ${base}/items -H "Content-Type: application/json" -d '{"name":"first"}'\ncurl${auth} ${base}/items`;
  }
  if (source.includes("std:queue")) {
    return `curl${auth} -X POST ${base}/ -H "Content-Type: application/json" -d '{"hello":"world"}'`;
  }
  return `curl${auth} ${base}/`;
}

// FirstRun answers "what now" on a new App: one request to try, then where to go. It leaves with the first new
// version, or when dismissed, and the choice is only a convenience of this browser.
export function FirstRun(p: { org: string; app: string; url: string; access: string; source: string | undefined }) {
  const { t } = useTranslation("operator");
  const key = hiddenKey(p.org, p.app);
  const [hidden, setHidden] = useState(() => readHidden(key));
  if (hidden) return null;
  const hide = () => {
    setHidden(true);
    try {
      window.localStorage.setItem(key, "1");
    } catch {
      // Blocked storage only means it comes back next time.
    }
  };
  const params = { org: p.org, app: p.app };
  const link = "font-medium text-text hover:underline";
  return (
    <SectionCard
      title={t("firstRun.title")}
      actions={
        <Button size="sm" variant="ghost" aria-label={t("firstRun.dismiss")} onClick={hide}>
          <X className="size-4" aria-hidden="true" />
        </Button>
      }
    >
      <ol className="flex flex-col gap-3 text-sm">
        <li className="flex min-w-0 flex-col gap-1">
          <span className="font-medium">{t("firstRun.tryIt")}</span>
          <span className="text-muted">{t("firstRun.tryItHint")}</span>
          <pre className="overflow-x-auto rounded bg-panel-2 p-3 font-mono text-xs">{sampleCurl(p.url, p.source ?? "", p.access === "key")}</pre>
          {p.access === "key" ? <span className="text-muted">{t("firstRun.keyHint")}</span> : null}
        </li>
        <li>
          <Link to="/$org/apps/$app/code" params={params} className={link}>{t("firstRun.editCode")}</Link>
          <span className="text-muted"> {t("firstRun.editCodeHint")}</span>
        </li>
        <li>
          <Link to="/$org/apps/$app/logs" params={params} className={link}>{t("firstRun.logs")}</Link>
          <span className="text-muted"> {t("firstRun.logsHint")}</span>
        </li>
        <li>
          <Link to="/$org/apps/$app/domains" params={params} className={link}>{t("firstRun.domain")}</Link>
          <span className="text-muted"> {t("firstRun.domainHint")}</span>
        </li>
      </ol>
    </SectionCard>
  );
}
