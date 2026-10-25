import { ApiError } from "@/lib/api";
import { i18n } from "@/lib/i18n";

export type TriggerError = { message: string; retry: boolean };

// describeTriggerError turns a failed trigger call into inline copy. plan_limit is a plan
// restriction, not a bug, so it explains itself and offers no retry. Busy and rate limits are
// transient, so they offer a retry.
export function describeTriggerError(err: unknown): TriggerError {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "plan_limit") {
      return { message: i18n.t("triggers:errors.planLimit"), retry: false };
    }
    if (err.code === "busy" || err.code === "overloaded") {
      return { message: i18n.t("triggers:errors.busy"), retry: true };
    }
    if (err.status === 429 || err.code === "rate_limited" || err.code === "queue_full") {
      const wait =
        err.retryAfter !== undefined
          ? i18n.t("triggers:errors.retryIn", { seconds: err.retryAfter })
          : i18n.t("triggers:errors.retryLater");
      return { message: i18n.t("triggers:errors.tooMany", { wait }), retry: true };
    }
    if (err.status === 422) {
      return { message: err.message, retry: false };
    }
    return { message: err.message || i18n.t("common:somethingWrong"), retry: false };
  }
  return { message: i18n.t("common:somethingWrong"), retry: false };
}
