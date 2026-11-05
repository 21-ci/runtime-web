import { createFileRoute } from "@tanstack/react-router";

import { AlertsPage } from "@/components/features/alerts/alerts-page";
import { INSTANCE_KINDS, instanceAlerts } from "@/components/features/alerts/use-alerts";

export const Route = createFileRoute("/admin/alerts")({
  component: () => <AlertsPage base={instanceAlerts} kinds={INSTANCE_KINDS} allowApp={false} />,
});
