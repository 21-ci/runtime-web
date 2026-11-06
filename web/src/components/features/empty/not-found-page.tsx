import { Link } from "@tanstack/react-router";
import { SearchX } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

// NotFoundContent is the one 404 body. Outside an org it stands alone, with no shell naming an org that does not exist.
export function NotFoundContent({ to = "/", params }: { to?: "/" | "/$org"; params?: { org: string } }) {
  const { t } = useTranslation("empty");
  return (
    <EmptyState
      icon={SearchX}
      title={t("notFound.title")}
      description={t("notFound.description")}
      action={
        <Button asChild variant="default">
          <Link to={to} params={params}>{t("notFound.home")}</Link>
        </Button>
      }
    />
  );
}

export function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center p-6">
      <NotFoundContent />
    </main>
  );
}
