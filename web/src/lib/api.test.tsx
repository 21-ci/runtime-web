import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Toaster } from "@/components/ui/toast";
import { server, apiError } from "@/test/msw";
import { api, ApiError, setCsrfToken, setNavigator } from "./api";
import { createQueryClient } from "./query";

function Probe({ path }: { path: string }) {
  useQuery({ queryKey: [path], queryFn: () => api.get(path), retry: false });
  return null;
}

function renderProbe(path: string) {
  const client = createQueryClient();
  render(
    <QueryClientProvider client={client}>
      <Probe path={path} />
      <Toaster />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  setCsrfToken(null);
});

describe("api client", () => {
  it("401 redirects to login", async () => {
    const nav = vi.fn();
    setNavigator(nav);
    server.use(http.get("/api/me", () => apiError(401, "unauthenticated")));

    await expect(api.get("/me")).rejects.toMatchObject({ status: 401, code: "unauthenticated" });
    expect(nav).toHaveBeenCalledWith(expect.stringMatching(/^\/login\?next=/));
  });

  it("password_change_required redirects to change-password", async () => {
    const nav = vi.fn();
    setNavigator(nav);
    server.use(http.get("/api/orgs", () => apiError(403, "password_change_required")));

    await expect(api.get("/orgs")).rejects.toBeInstanceOf(ApiError);
    expect(nav).toHaveBeenCalledWith("/change-password");
  });

  it("mfa_enrollment_required redirects to the security page", async () => {
    const nav = vi.fn();
    setNavigator(nav);
    server.use(http.get("/api/orgs", () => apiError(403, "mfa_enrollment_required")));

    await expect(api.get("/orgs")).rejects.toBeInstanceOf(ApiError);
    expect(nav).toHaveBeenCalledWith("/me/security");
  });

  it("sends X-CSRF-Token and credentials on unsafe methods", async () => {
    let seen: string | null = null;
    setCsrfToken("csrf-123");
    server.use(
      http.post("/api/orgs/acme/projects", ({ request }) => {
        seen = request.headers.get("X-CSRF-Token");
        return new HttpResponse(null, { status: 204 });
      }),
    );

    await api.post("/orgs/acme/projects", { slug: "web" });
    expect(seen).toBe("csrf-123");
  });

  it("busy error shows 'Busy — retry' toast", async () => {
    setNavigator(vi.fn());
    server.use(http.get("/api/orgs/acme/apps", () => apiError(503, "busy")));

    renderProbe("/orgs/acme/apps");
    expect(await screen.findByText("Busy — retry")).toBeInTheDocument();
  });

  it("429 shows retry-after", async () => {
    setNavigator(vi.fn());
    server.use(
      http.get("/api/orgs/acme/apps", () =>
        HttpResponse.json(
          { error: { code: "rate_limited", message: "slow down" } },
          { status: 429, headers: { "Retry-After": "30" } },
        ),
      ),
    );

    renderProbe("/orgs/acme/apps");
    expect(await screen.findByText("Too many requests. Retry in 30 s.")).toBeInTheDocument();
  });

  it("412-stale 409 shows reload prompt", async () => {
    setNavigator(vi.fn());
    server.use(http.get("/api/orgs/acme/apps/web", () => apiError(409, "stale")));

    renderProbe("/orgs/acme/apps/web");
    expect(await screen.findByText(/Changed elsewhere/)).toBeInTheDocument();
  });

  it("runtime_unavailable shows a toast", async () => {
    setNavigator(vi.fn());
    server.use(http.get("/api/orgs/acme/apps", () => apiError(502, "runtime_unavailable")));

    renderProbe("/orgs/acme/apps");
    expect(await screen.findByText(/runtime is unreachable/i)).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
