import { describe, expect, it, vi } from "vitest";
import { Router } from "../../src/http/router.ts";
import { RuntimeError, RuntimeUnavailable } from "../../src/runtime/client.ts";
import { mapRuntimeError, runtimeAppError } from "../../src/runtime/errors.ts";
import { AppError } from "../../src/http/errors.ts";

const rtErr = (status: number, code: string, retryAfter?: number) => new RuntimeError(status, code, "m", {}, retryAfter);

describe("runtime error mapping", () => {
  it.each([
    [rtErr(404, "service_not_found"), 404, "not_found"],
    [rtErr(412, "precondition_failed"), 409, "stale"],
    [rtErr(409, "host_taken"), 409, "host_taken"],
    [rtErr(422, "validation_failed"), 422, "validation_failed"],
    [rtErr(429, "build_quota", 3), 429, "build_quota"],
    [rtErr(503, "queue_timeout", 2), 503, "busy"],
    [rtErr(503, "overloaded"), 503, "busy"],
    [rtErr(503, "control_disabled"), 502, "runtime_unavailable"],
    [rtErr(500, "boom"), 502, "runtime_unavailable"],
    [rtErr(403, "scope_denied"), 403, "scope_denied"],
    [new RuntimeUnavailable("down"), 502, "runtime_unavailable"],
  ])("%s → %i %s", (e, status, code) => {
    const m = runtimeAppError(e);
    expect(m?.status).toBe(status);
    expect(m?.code).toBe(code);
  });

  it("logs the underlying cause when it answers runtime_unavailable (the envelope hides it)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      runtimeAppError(new RuntimeUnavailable("POST /v1/tenants: binding_upstream"));
      runtimeAppError(new RuntimeError(500, "boom", "kaput", {}));
      const lines = spy.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes("POST /v1/tenants: binding_upstream"))).toBe(true);
      expect(lines.some((l) => l.includes("boom"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("carries retry_after", () => {
    expect(runtimeAppError(rtErr(429, "rate_limited", 5))?.details).toEqual({ retry_after: 5 });
  });

  it("leaves non-runtime errors alone", () => {
    const e = new Error("x");
    expect(runtimeAppError(e)).toBeNull();
    expect(mapRuntimeError(e)).toBe(e);
    const a = new AppError(400, "x", "y");
    expect(mapRuntimeError(a)).toBe(a);
  });

  it("router maps an uncaught RuntimeError instead of answering 500", async () => {
    const r = new Router().get("/api/x", () => {
      throw rtErr(503, "overloaded", 1);
    });
    const res = await r.handle(new Request("http://h/api/x"), { basePath: "", clientIp: undefined });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("busy");
  });
});
