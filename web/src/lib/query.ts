import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { ApiError } from "./api";

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
        action: { label: "Reload", onClick: () => window.location.reload() },
      });
      break;
    case "network":
      toast.error(err.message);
      break;
    default:
      break;
  }
}

export function createQueryClient() {
  return new QueryClient({
    queryCache: new QueryCache({ onError: handleApiError }),
    mutationCache: new MutationCache({
      onError: (err, _vars, _ctx, mutation) => {
        if (mutation.meta?.skipGlobalError) return;
        handleApiError(err);
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
