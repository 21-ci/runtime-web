import { http, HttpResponse } from "msw";

import { server } from "./msw";

// Shell fixtures: one owner org (acme, two projects) and one member org (beta, no projects).
export const orgs = [
  { id: "org_1", slug: "acme", name: "Acme", created_at: 1, role: "owner" },
  { id: "org_2", slug: "beta", name: "Beta", created_at: 1, role: "member" },
];

export const projects = [
  { slug: "web", name: "Web", environments: ["dev", "prod"], created_at: 1, updated_at: 1, role: "admin" },
  { slug: "empty", name: "Empty", environments: ["dev"], created_at: 1, updated_at: 1, role: "admin" },
];

export const apps = [
  {
    slug: "hello",
    name: "Hello",
    project: "web",
    environment: "dev",
    live_version: 1,
    status: { build_state: "ready", tier: "standard", last_error: null },
  },
];

const limits = {
  day: "2026-10-23",
  resets_at: 1_700_000_000_000,
  invocations: { limit: 1000, used: 10, remaining: 990, period: "day" },
  egress_bytes: { limit: null, used: 0, remaining: null, period: "day" },
  storage_bytes: { limit: 1024, used: 512, remaining: 512, period: "total" },
  services: { limit: 5, used: 1, remaining: 4, period: "total" },
  schedules: { limit: 5, used: 0, remaining: 5, period: "total" },
};

export const me = {
  user: {
    id: "usr_1",
    email: "ada@example.test",
    name: "Ada",
    instance_admin: false,
    must_change_password: false,
    disabled: false,
    totp_enabled: false,
    created_at: 1,
  },
  csrf: "csrf-token-1",
  orgs: orgs.map((o) => ({ slug: o.slug, name: o.name, role: o.role })),
  policy: { require_2fa: false, password_login_disabled: false },
  mfa_enrollment_required: false,
};

// useShellHandlers serves the org-scoped reads the shell and its pages make.
export function useShellHandlers(logoutSpy?: () => void) {
  // After logout the server session is gone, so /api/me answers 401 like the real API.
  let signedOut = false;
  server.use(
    http.get("/api/me", () =>
      signedOut
        ? HttpResponse.json({ error: { code: "unauthenticated", message: "signed out" } }, { status: 401 })
        : HttpResponse.json(me),
    ),
    http.get("/api/orgs", () => HttpResponse.json({ items: orgs })),
    http.get("/api/orgs/:org/projects", ({ params }) =>
      HttpResponse.json({ items: params.org === "acme" ? projects : [] }),
    ),
    http.get("/api/orgs/:org/projects/:p/environments", ({ params }) => {
      const p = projects.find((x) => x.slug === params.p);
      return HttpResponse.json({ items: p?.environments ?? [] });
    }),
    http.get("/api/orgs/:org/apps", ({ request }) => {
      const project = new URL(request.url).searchParams.get("project");
      const items = apps.filter((a) => !project || a.project === project);
      return HttpResponse.json({ items, next_cursor: null });
    }),
    http.get("/api/orgs/:org/limits", () => HttpResponse.json(limits)),
    http.get("/api/orgs/:org/usage", () => HttpResponse.json({ items: [] })),
    // Dashboard cards; tests that care override these with server.use(...).
    http.get("/api/orgs/:org/members", () => HttpResponse.json({ items: [] })),
    http.get("/api/orgs/:org/audit", () => HttpResponse.json({ items: [], next_cursor: null })),
    http.get("/api/invites/accept/:token", () =>
      HttpResponse.json({ email: "grace@example.test", org_name: "Acme" }),
    ),
    http.post("/api/auth/logout", () => {
      signedOut = true;
      logoutSpy?.();
      return new HttpResponse(null, { status: 204 });
    }),
  );
}
