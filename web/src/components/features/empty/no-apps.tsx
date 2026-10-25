import { Link } from "@tanstack/react-router";
import { Boxes, Globe, Clock, Database, ListTodo } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import type { Template } from "@/hooks/orgs";

export const TEMPLATES: { id: Template; title: string; blurb: string; Icon: typeof Globe }[] = [
  { id: "http", title: "HTTP handler", blurb: "Answer web requests", Icon: Globe },
  { id: "cron", title: "Scheduled job", blurb: "Run on a timer", Icon: Clock },
  { id: "queue", title: "Queue worker", blurb: "Process messages", Icon: ListTodo },
  { id: "sqlite-crud", title: "SQLite CRUD", blurb: "JSON API over a table", Icon: Database },
];

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
