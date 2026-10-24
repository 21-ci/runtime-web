import { FolderPlus } from "lucide-react";

import { CreateProjectDialog } from "@/components/features/org/create-project-dialog";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// NoProjects is the org overview empty state: one explanation and one primary action.
export function NoProjects({ org }: { org: string }) {
  return (
    <EmptyState entity="projects"
      icon={FolderPlus}
      title="No projects yet"
      description="A project groups apps and the environments they deploy to. Create one to start."
      action={
        <CreateProjectDialog
          org={org}
          trigger={<Button>Create project</Button>}
        />
      }
    />
  );
}
