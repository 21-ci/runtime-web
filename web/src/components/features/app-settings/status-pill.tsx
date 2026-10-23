import type { AppDetail } from "./api";

// StatusPill shows the runtime status of the app: build state, tier, in-flight calls, and the last
// error when there is one.
export function StatusPill({ status }: { status: AppDetail["status"] }) {
  return (
    <div role="status" aria-label="App status" className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full border border-line-strong px-2 py-0.5 font-medium text-text">
          {status.build_state}
        </span>
        <span className="text-muted">tier {status.tier}</span>
        <span className="text-muted">{status.inflight} in flight</span>
      </div>
      {status.last_error ? <p className="text-danger-text">{status.last_error}</p> : null}
    </div>
  );
}
