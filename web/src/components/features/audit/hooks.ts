import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { AuditEntry } from "./audit-page";

// useRecentActivity returns the newest audit entries for the org (admins only on the server).
// Routine reads (an instance admin's usage reads) stay in the full audit log but not in this feed.
export function useRecentActivity(org: string, enabled: boolean, limit = 6) {
  return useQuery({
    queryKey: ["audit", org, "recent", limit],
    queryFn: () =>
      api
        .get<{ items: AuditEntry[]; next_cursor: string | null }>(
          `/orgs/${encodeURIComponent(org)}/audit?limit=${limit}&exclude_action=org.usage.read`,
        )
        .then((r) => r.items),
    enabled,
  });
}
