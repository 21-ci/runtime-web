import { Link } from "@tanstack/react-router";
import { Boxes, Globe, Clock, Database, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// TEMPLATES lists the app templates; titleKey and blurbKey are keys in the apps namespace.
export const TEMPLATES = [
  { id: "http", titleKey: "templates.http.title", blurbKey: "templates.http.blurb", Icon: Globe },
  { id: "cron", titleKey: "templates.cron.title", blurbKey: "templates.cron.blurb", Icon: Clock },
  { id: "queue", titleKey: "templates.queue.title", blurbKey: "templates.queue.blurb", Icon: ListTodo },
  { id: "sqlite-crud", titleKey: "templates.sqliteCrud.title", blurbKey: "templates.sqliteCrud.blurb", Icon: Database },
] as const;

// NoApps is the empty project state: a create-app CTA that preselects the project.
export function NoApps({ org, project }: { org: string; project: string }) {
  const { t } = useTranslation("empty");
  return (
    <EmptyState entity="apps"
      icon={Boxes}
      title={t("noApps.title")}
      description={t("noApps.description")}
      action={
        <Button asChild variant="default">
          <Link to="/$org/apps/new" params={{ org }} search={{ project }}>
            {t("noApps.action")}
          </Link>
        </Button>
      }
    />
  );
}
