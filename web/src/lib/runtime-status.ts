import { useSyncExternalStore } from "react";

// RuntimeStatus is set by the API client when the runtime is busy or unreachable. It is never an
// error of the user's app; the banner explains it and clears on the next successful call.
export type RuntimeStatus = "busy" | "unavailable" | null;

let current: RuntimeStatus = null;
const listeners = new Set<() => void>();

export function setRuntimeStatus(next: RuntimeStatus) {
  if (next === current) return;
  current = next;
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useRuntimeStatus(): RuntimeStatus {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
