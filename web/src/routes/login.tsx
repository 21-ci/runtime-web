import { createFileRoute, Outlet } from "@tanstack/react-router";

// Layout for /login and /login/mfa. The child routes render the forms.
export const Route = createFileRoute("/login")({
  component: () => <Outlet />,
});
