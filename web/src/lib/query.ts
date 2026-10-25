import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "./api";
import { errorMessage } from "./error-message";
import { i18n } from "./i18n";

// page wraps the reload so tests can observe the stale toast's Reload action.
export const page = {
  reload: () => window.location.reload(),
};

// handleApiError maps shared API errors to toasts. Form-level errors (422, 401 invalid_credentials)
// stay inline in the page and are not toasted here.
export function handleApiError(err: unknown) {
  if (!(err instanceof ApiError)) {
    toast.error(i18n.t("common:somethingWrong"));
    return;
  }
  switch (err.code) {
    case "busy":
      toast.error(i18n.t("errors:busy"));
      break;
    case "rate_limited":
      toast.error(
        err.retryAfter !== undefined
          ? i18n.t("errors:rate_limited_retry", { seconds: err.retryAfter })
          : i18n.t("errors:rate_limited"),
      );
      break;
    case "runtime_unavailable":
      toast.error(i18n.t("errors:runtime_unavailable"));
      break;
    case "stale":
      toast.error(i18n.t("errors:stale"), {
        action: { label: i18n.t("common:reload"), onClick: () => page.reload() },
      });
      break;
    case "network":
      toast.error(i18n.t("errors:network"));
      break;
    default:
      break;
  }
}

// handleMutationError is the global handler for failed writes: shared errors as in handleApiError,
// and every other ApiError (forbidden, conflicts, internal, a 422 without field errors) as a toast,
// so no write fails silently. A 422 with field errors stays inline in the form; 401 redirects.
// Mutations that show every error themselves opt out with meta.skipGlobalError.
export function handleMutationError(err: unknown) {
  if (!(err instanceof ApiError)) return handleApiError(err);
  switch (err.code) {
    case "busy":
    case "rate_limited":
    case "runtime_unavailable":
    case "stale":
    case "network":
      return handleApiError(err);
    case "unauthenticated":
      return;
    case "forbidden":
      toast.error(i18n.t("errors:forbidden"));
      return;
    default:
      if (err.status === 422 && Object.keys(err.fieldErrors()).length > 0) return;
      toast.error(errorMessage(err));
  }
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: handleApiError }),
    mutationCache: new MutationCache({
      onError: (err, _vars, _ctx, mutation) => {
        if (mutation.meta?.skipGlobalError) return;
        handleMutationError(err);
      },
    }),
    defaultOptions: {
      queries: {
        retry: (count, err) => !(err instanceof ApiError) && count < 2,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });
}
