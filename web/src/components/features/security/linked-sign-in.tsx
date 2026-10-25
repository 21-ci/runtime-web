import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuthProviders } from "@/hooks/auth";
import { ApiError } from "@/lib/api";

import { useLinkProvider } from "./hooks";

// LinkedSignInSection lists the OAuth providers the instance offers and links one to this account.
// OAuth sign-in never links by email, so linking happens only from this signed-in page.
export function LinkedSignInSection() {
  const providers = useAuthProviders();
  const link = useLinkProvider();
  const { t } = useTranslation("security");
  // The callback redirects back here with ?error=identity_taken when the identity belongs elsewhere.
  const [error, setError] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get("error") === "identity_taken" ? t("linked.identityTaken") : null,
  );
  const [pending, setPending] = useState<string | null>(null);

  function startLink(id: string) {
    setError(null);
    setPending(id);
    link.mutate(id, {
      onError: (err) => {
        setPending(null);
        if (err instanceof ApiError && err.code === "identity_taken") setError(t("linked.identityTaken"));
        else setError(t("linked.failed"));
      },
    });
  }

  return (
    <section aria-labelledby="linked-heading" aria-label={t("linked.title")} className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-5 shadow-card">
      <div>
        <h2 id="linked-heading" className="text-[15px] font-semibold">
          {t("linked.title")}
        </h2>
        <p className="text-sm text-muted">{t("linked.description")}</p>
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {providers.isPending ? (
        <Skeleton className="h-16 w-full" />
      ) : providers.data && providers.data.providers.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {providers.data.providers.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-3 rounded-md border border-line p-3">
              <span className="text-sm font-medium">{p.name}</span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={t("linked.linkLabel", { name: p.name })}
                disabled={pending !== null}
                onClick={() => startLink(p.id)}
              >
                {t("linked.link")}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{t("linked.none")}</p>
      )}
    </section>
  );
}
