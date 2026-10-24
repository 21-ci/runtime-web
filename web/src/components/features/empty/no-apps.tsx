import { Link } from "@tanstack/react-router";
import { Boxes, Globe, Clock, Database, ListTodo } from "lucide-react";

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
  return (
    <EmptyState
      icon={Boxes}
      title="No apps in this project"
      description="Create an app from a template to deploy code to one of the project's environments."
      action={
        <Button asChild variant="default">
          <Link to="/$org/apps/new" params={{ org }} search={{ project }}>
            Create app
          </Link>
        </Button>
      }
    />
  );
}
