import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "./api";

// page wraps the reload so tests can observe the stale toast's Reload action.
export const page = {
  reload: () => window.location.reload(),
};

// handleApiError maps shared API errors to toasts. Form-level errors (422, 401 invalid_credentials)
// stay inline in the page and are not toasted here.
export function handleApiError(err: unknown) {
  if (!(err instanceof ApiError)) {
    toast.error("Something went wrong. Try again.");
    return;
  }
  switch (err.code) {
    case "busy":
      toast.error("Busy — retry");
      break;
    case "rate_limited":
      toast.error(
        err.retryAfter !== undefined
          ? `Too many requests. Retry in ${err.retryAfter} s.`
          : "Too many requests. Wait and retry.",
      );
      break;
    case "runtime_unavailable":
      toast.error("The app runtime is unreachable. Retry shortly.");
      break;
    case "stale":
      toast.error("Changed elsewhere. Reload to see the latest version.", {
        action: { label: "Reload", onClick: () => page.reload() },
      });
      break;
    case "network":
      toast.error(err.message);
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
      toast.error("You don't have permission to do that.");
      return;
    default:
      if (err.status === 422 && Object.keys(err.fieldErrors()).length > 0) return;
      toast.error(err.message || "Something went wrong. Try again.");
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
