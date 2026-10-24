import { Badge } from "@/components/ui/badge";
import type { AppDetail } from "./api";

const VARIANT: Record<string, "success" | "danger" | "warning" | "default"> = {
  ready: "success",
  failed: "danger",
  building: "warning",
  pending: "warning",
};

// StatusPill shows the runtime status of the app: build state, tier, in-flight calls, and the last
// error when there is one.
export function StatusPill({ status }: { status: AppDetail["status"] }) {
  return (
    <div role="status" aria-label="App status" className="flex flex-col gap-1 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={VARIANT[status.build_state] ?? "default"} dot>
          {status.build_state}
        </Badge>
        <span className="text-[12px] text-muted">tier {status.tier}</span>
        <span className="text-[12px] text-muted">{status.inflight} in flight</span>
      </div>
      {status.last_error ? <p className="text-danger-text">{status.last_error}</p> : null}
    </div>
  );
}
