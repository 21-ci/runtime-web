import { FolderPlus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// NoProjects is the org overview empty state: one explanation and one primary action.
export function NoProjects({ org }: { org: string }) {
  const { t } = useTranslation("empty");
  return (
    <EmptyState entity="projects"
      icon={FolderPlus}
      title={t("noProjects.title")}
      description={t("noProjects.description")}
      action={
        <CreateProjectDialog
          org={org}
          trigger={<Button>{t("noProjects.action")}</Button>}
        />
      }
    />
  );
}
