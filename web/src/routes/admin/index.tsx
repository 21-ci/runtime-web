import { createFileRoute, redirect } from "@tanstack/react-router";

// /admin has no page of its own: the parent route checks instance admin, then this sends the
// caller to the user directory.
export const Route = createFileRoute("/admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/admin/users" });
  },
});
