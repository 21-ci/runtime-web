import { ApiError } from "@/lib/api";

export type TriggerError = { message: string; retry: boolean };

// describeTriggerError turns a failed trigger call into inline copy. plan_limit is a plan
// restriction, not a bug, so it explains itself and offers no retry. Busy and rate limits are
// transient, so they offer a retry.
export function describeTriggerError(err: unknown): TriggerError {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "plan_limit") {
      return {
        message:
          "This trigger is not allowed on your plan, or the schedule limit is reached. Remove an existing schedule or ask an instance admin to change the plan.",
        retry: false,
      };
    }
    if (err.code === "busy" || err.code === "overloaded") {
      return { message: "The runtime is busy right now. Retry in a moment.", retry: true };
    }
    if (err.status === 429 || err.code === "rate_limited" || err.code === "queue_full") {
      const wait =
        err.retryAfter !== undefined ? ` Retry in ${err.retryAfter} s.` : " Retry in a moment.";
      return { message: `Too many requests.${wait}`, retry: true };
    }
    if (err.status === 422) {
      return { message: err.message, retry: false };
    }
    return { message: err.message || "Something went wrong. Try again.", retry: false };
  }
  return { message: "Something went wrong. Try again.", retry: false };
}
