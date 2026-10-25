import { AlertTriangle, SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/empty-state";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";

// QueryError renders a failed read. A 404 means the resource is not there (or not visible to the
// caller) and gets a not-found state; anything else gets a retry action.
export function QueryError({
  error,
  onRetry,
  notFoundTitle,
  notFoundDescription,
}: {
  error: unknown;
  onRetry: () => void;
  notFoundTitle: string;
  notFoundDescription?: string;
}) {
  const { t } = useTranslation(["empty", "common"]);
  if (error instanceof ApiError && error.status === 404) {
    return <EmptyState icon={SearchX} title={notFoundTitle} description={notFoundDescription} />;
  }
  return (
    <EmptyState
      icon={AlertTriangle}
      title={t("queryError.title")}
      description={t("queryError.description")}
      action={
        <Button variant="secondary" onClick={onRetry}>
          {t("common:retry")}
        </Button>
      }
    />
  );
}
