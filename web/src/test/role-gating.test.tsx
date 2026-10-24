import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { setCsrfToken } from "@/lib/api";
import { apiError, server } from "./msw";
import { renderAt } from "./render";
import { apps, orgs, projects, useShellHandlers } from "./shell-fixtures";

const BASE = "/api/orgs/acme/apps/hello";

const detail = {
  ...apps[0],
  etag: '"e1"',
  runtime: "deno",
  profile: null,
  access: "public",
  url: "https://run.example.test/s/hello/",
  scaling: null,
  ingress: null,
  egress: null,
  call: { allowed_callers: [] },
  triggers: null,
  status: { ...apps[0].status, inflight: 0, admission: null },
  limits: { requested: null, effective: {}, source: "plan" },
};

// useProjectRoleHandlers makes the caller a plain org member with role on project "web".
function useProjectRoleHandlers(role: "viewer" | "developer" | "admin") {
  useShellHandlers();
  server.use(
    http.get("/api/orgs", () => HttpResponse.json({ items: [{ ...orgs[0], role: "member" }] })),
    http.get("/api/orgs/acme/projects", () => HttpResponse.json({ items: [{ ...projects[0], role }] })),
    http.get(BASE, () => HttpResponse.json(detail)),
    http.get(`${BASE}/env`, () => HttpResponse.json({ env: { MODE: "prod" } })),
    http.get(`${BASE}/secrets`, () => HttpResponse.json({ items: [{ name: "API_KEY", updated_at: 1 }] })),
    http.get(`${BASE}/domains`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/schedules`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/queue`, () => HttpResponse.json({ depth: 0, inflight: 0, dlq: 0 })),
    http.get(`${BASE}/dlq`, () => HttpResponse.json({ items: [] })),
  );
}

describe("role gating", { timeout: 15_000 }, () => {
  afterEach(() => setCsrfToken(null));

  it("viewer sees app settings read-only: no Save or Delete", async () => {
    useProjectRoleHandlers("viewer");
    renderAt("/acme/apps/hello/settings");
    expect(await screen.findByRole("heading", { name: /hello settings/i })).toBeInTheDocument();
    expect(await screen.findByText("API_KEY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add domain/i })).toBeNull();
  });

  it("developer may edit env but not secrets or domains", async () => {
    useProjectRoleHandlers("developer");
    renderAt("/acme/apps/hello/settings");
    expect(await screen.findByRole("button", { name: "Save variables" })).toBeInTheDocument();
    expect(await screen.findByText("API_KEY")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save secret" })).toBeNull();
    expect(screen.queryByRole("button", { name: /delete api_key/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add domain/i })).toBeNull();
    expect(screen.getByRole("button", { name: /delete app/i })).toBeInTheDocument();
  });

  it("viewer cannot use trigger controls", async () => {
    useProjectRoleHandlers("viewer");
    renderAt("/acme/apps/hello/triggers");
    const save = await screen.findByRole("button", { name: /save http route/i });
    await waitFor(() => expect(save).toBeDisabled());
    expect(screen.getByRole("button", { name: /enqueue test message/i })).toBeDisabled();
  });

  it("a 403 on save shows a permission toast", async () => {
    useProjectRoleHandlers("developer");
    server.use(http.put(`${BASE}/env`, () => apiError(403, "forbidden", "forbidden")));
    renderAt("/acme/apps/hello/settings");
    await userEvent.click(await screen.findByRole("button", { name: "Save variables" }));
    expect(await screen.findByText(/don't have permission/i)).toBeInTheDocument();
  });
});
