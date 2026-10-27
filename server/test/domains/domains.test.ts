// Domains: validation, claim/conflict, verify and activation via
// the runtime, expiry and deactivation in the checker, unmap retries, reconcile, and
// authz on the app routes. Clock is the harness fake clock (tick).
import { describe, expect, it } from "vitest";
import { MAX_PENDING_PER_ORG, normalizeHost } from "../../src/domains/domains.ts";
import { checkOnce, ACTIVE_EVERY_MS, PENDING_TTL_MS } from "../../src/domains/checker.ts";
import { APP, DOMAINS, ORG, seed, type Seeded } from "./fakes.ts";
import { errCode } from "../auth/helpers.ts";
import { testConfig } from "../harness.ts";
import { appIndexPut } from "../../src/apps/index-table.ts";

const CONSOLE = "console.test";

async function claim(s: Seeded, host: string, who = s.owner): Promise<{ id: string; txt_value: string; txt_name: string; status: string; host: string }> {
  const res = await who.call("POST", DOMAINS, { host });
  expect(res.status).toBe(201);
  return res.json();
}

async function verify(s: Seeded, id: string) {
  return s.owner.call("POST", `${DOMAINS}/${id}/verify`);
}

describe("host normalisation", () => {
  it.each([
    ["Shop.Example.COM.", "shop.example.com"],
    ["  bücher.example  ", "xn--bcher-kva.example"],
    ["a-b.example.org", "a-b.example.org"],
  ])("accepts %s", (raw, want) => {
    expect(normalizeHost(raw, CONSOLE)).toBe(want);
  });

  it.each([
    ["192.168.0.1", "ip"],
    ["[::1]", "plain"],
    ["*.example.com", "plain"],
    ["example.com:8080", "plain"],
    ["localhost", "single label"],
    ["example.123", "numeric tld"],
    [`${"a".repeat(64)}.example.com`, "bad label"],
    [`${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}.com`, "too long"],
    [CONSOLE, "reserved"],
    ["-bad.example.com", "bad label"],
  ])("rejects %s", (raw) => {
    expect(() => normalizeHost(raw, CONSOLE)).toThrow();
  });
});

describe("POST /api/orgs/{org}/apps/{app}/domains", () => {
  it("claims a host as pending with its TXT name and value", async () => {
    const s = await seed();
    const d = await claim(s, "Shop.Example.com");
    expect(d).toMatchObject({ host: "shop.example.com", status: "pending", txt_name: "_rtweb.shop.example.com" });
    expect(d.txt_value).toMatch(/^[0-9a-f]{32}$/);
    const audit = await s.db.first<{ action: string }>("SELECT action FROM audit WHERE action = 'domain.add'");
    expect(audit?.action).toBe("domain.add");
  });

  it("rejects an invalid host with 422 invalid", async () => {
    const s = await seed();
    const res = await s.owner.call("POST", DOMAINS, { host: "10.0.0.1" });
    expect(res.status).toBe(422);
    expect(await errCode(res)).toBe("invalid");
  });

  it("refuses a host the org already claimed with 409 host_taken", async () => {
    const s = await seed();
    await claim(s, "taken.example.com");
    const res = await s.owner.call("POST", DOMAINS, { host: "taken.example.com" });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("host_taken");
  });

  it("answers one generic host_taken for a host held by another org (M5)", async () => {
    const s = await seed();
    await s.db.run(
      "INSERT INTO domains (id, org_id, app_slug, project_slug, service_id, host, txt_token, status, created_at, txt_misses) VALUES ('dom_x', 'org_2', 'a', 'p', 'svc_x', 'held.example.com', 't', 'pending', ?, 0)",
      [s.app.deps.now()],
    );
    const theirs = await s.owner.call("POST", DOMAINS, { host: "held.example.com" });
    await claim(s, "mine.example.com");
    const ours = await s.owner.call("POST", DOMAINS, { host: "mine.example.com" });
    expect(theirs.status).toBe(409);
    const a = (await theirs.json()) as { error: unknown };
    const b = (await ours.json()) as { error: unknown };
    expect(a.error).toEqual(b.error);
    expect(JSON.stringify(a)).not.toMatch(/org/i);
  });

  it("purges failed rows so the host can be claimed again", async () => {
    const s = await seed();
    await s.db.run(
      "INSERT INTO domains (id, org_id, app_slug, project_slug, service_id, host, txt_token, status, created_at, txt_misses) VALUES ('dom_x', 'org_2', 'a', 'p', 'svc_x', 'old.example.com', 't', 'failed', ?, 0)",
      [s.app.deps.now()],
    );
    const d = await claim(s, "old.example.com");
    expect(d.status).toBe("pending");
    expect(await s.db.first("SELECT id FROM domains WHERE id = 'dom_x'")).toBeNull();
  });

  it("caps pending claims per org", async () => {
    const s = await seed();
    for (let i = 0; i < MAX_PENDING_PER_ORG; i++) await claim(s, `p${i}.example.com`);
    const res = await s.owner.call("POST", DOMAINS, { host: "one-more.example.com" });
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("pending_limit");
  });

  it("does not expose another org's apps", async () => {
    const s = await seed();
    const res = await s.other.call("POST", DOMAINS, { host: "x.example.com" });
    expect(res.status).toBe(404);
  });

  it("requires project admin: a developer gets 403, a viewer gets 403, an outsider gets 404", async () => {
    const s = await seed();
    expect((await s.dev.call("POST", DOMAINS, { host: "a.example.com" })).status).toBe(403);
    expect((await s.viewer.call("POST", DOMAINS, { host: "a.example.com" })).status).toBe(403);
    expect((await s.outsider.call("POST", DOMAINS, { host: "a.example.com" })).status).toBe(404);
  });

  it("answers 404 for an unknown app", async () => {
    const s = await seed();
    const res = await s.owner.call("POST", `/api/orgs/${ORG.slug}/apps/nope/domains`, { host: "a.example.com" });
    expect(res.status).toBe(404);
  });
});

describe("verify", () => {
  it("keeps pending while the TXT record does not match and records the check", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", ["something-else"]);
    const res = await verify(s, d.id);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "pending", last_checked_at: s.app.deps.now() });
    expect(s.rt.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("activates after the TXT matches, mapping the host on the runtime first", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    const res = await verify(s, d.id);
    expect(await res.json()).toMatchObject({ status: "active" });
    const put = s.rt.calls.find((c) => c.method === "PUT");
    expect(put?.path).toBe(`/v1/services/${APP.serviceId}/hosts/shop.example.com`);
    expect(s.rt.hosts.get("shop.example.com")).toBe(APP.serviceId);
  });

  it("leaves the row failed with 409 host_taken when the runtime holds the host", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.rt.takeHost("shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    const res = await verify(s, d.id);
    expect(res.status).toBe(409);
    expect(await errCode(res)).toBe("host_taken");
    const row = await s.db.first<{ status: string }>("SELECT status FROM domains WHERE id = ?", [d.id]);
    expect(row?.status).toBe("failed");
  });

  it("maps a transient runtime failure to 503 busy and keeps the row pending", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    s.rt.failNext(503, "PUT");
    const res = await verify(s, d.id);
    expect(res.status).toBe(503);
    expect(await errCode(res)).toBe("busy");
    const row = await s.db.first<{ status: string }>("SELECT status FROM domains WHERE id = ?", [d.id]);
    expect(row?.status).toBe("pending");
  });
});

describe("delete", () => {
  it("removes an active domain, unmapping it on the runtime", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    const res = await s.owner.call("DELETE", `${DOMAINS}/${d.id}`);
    expect(res.status).toBe(204);
    expect(s.rt.hosts.has("shop.example.com")).toBe(false);
    expect(await s.db.first("SELECT id FROM domains WHERE id = ?", [d.id])).toBeNull();
  });

  it("keeps a queued unmap when the runtime DELETE fails, and the checker retries it", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    s.rt.failNext(503, "DELETE");
    expect((await s.owner.call("DELETE", `${DOMAINS}/${d.id}`)).status).toBe(204);
    expect(s.rt.hosts.has("shop.example.com")).toBe(true);
    expect(await s.db.all("SELECT id FROM pending_unmaps")).toHaveLength(1);
    await checkOnce(s.app.deps);
    expect(s.rt.hosts.has("shop.example.com")).toBe(false);
    expect(await s.db.all("SELECT id FROM pending_unmaps")).toHaveLength(0);
  });

  it("404s on a domain of another app or org", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    expect((await s.owner.call("DELETE", `/api/orgs/${ORG.slug}/apps/other/domains/${d.id}`)).status).toBe(404);
  });
});

describe("checker", () => {
  it("expires a pending claim after 24 h", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.app.tick(PENDING_TTL_MS + 1);
    await checkOnce(s.app.deps);
    expect(await s.db.first("SELECT status FROM domains WHERE id = ?", [d.id])).toBeNull();
    const ex = await s.db.first("SELECT action FROM audit WHERE action = 'domain.expire'");
    expect(ex).not.toBeNull();
    expect((await claim(s, "shop.example.com")).status).toBe("pending");
  });

  it("deactivates an active host after 3 consecutive TXT misses and unmaps it", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    s.zone.set("_rtweb.shop.example.com", []);
    for (let i = 0; i < 3; i++) {
      s.app.tick(ACTIVE_EVERY_MS);
      await checkOnce(s.app.deps);
    }
    const row = await s.db.first<{ status: string }>("SELECT status FROM domains WHERE id = ?", [d.id]);
    expect(row?.status).toBe("failed");
    expect(s.rt.hosts.has("shop.example.com")).toBe(false);
  });

  it("resets the miss count when the TXT is seen again", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    s.zone.set("_rtweb.shop.example.com", []);
    s.app.tick(ACTIVE_EVERY_MS);
    await checkOnce(s.app.deps);
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    s.app.tick(ACTIVE_EVERY_MS);
    await checkOnce(s.app.deps);
    const row = await s.db.first<{ status: string; txt_misses: number }>("SELECT status, txt_misses FROM domains WHERE id = ?", [d.id]);
    expect(row).toMatchObject({ status: "active", txt_misses: 0 });
  });

  it("re-maps an active host the runtime lost", async () => {
    const s = await seed();
    const d = await claim(s, "shop.example.com");
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    s.rt.hosts.delete("shop.example.com");
    await checkOnce(s.app.deps);
    expect(s.rt.hosts.get("shop.example.com")).toBe(APP.serviceId);
  });
});

describe("reads", () => {
  it("lists only the app's domains; viewers may read", async () => {
    const s = await seed();
    await claim(s, "one.example.com");
    const res = await s.viewer.call("GET", DOMAINS);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { host: string; cert_status: string }[] };
    expect(body.items.map((i) => i.host)).toEqual(["one.example.com"]);
    expect(body.items[0]?.cert_status).toBe("none");
  });

  it("serves tls-ask 200 only for active hosts", async () => {
    const s = await seed();
    const local = { headers: { "x-rt-client-ip": "127.0.0.1" } };
    const d = await claim(s, "shop.example.com");
    expect((await s.app.call("GET", "/api/internal/tls-ask?domain=shop.example.com")).status).toBe(404);
    s.zone.set("_rtweb.shop.example.com", [d.txt_value]);
    await verify(s, d.id);
    expect((await s.app.call("GET", "/api/internal/tls-ask?domain=SHOP.example.com", local)).status).toBe(200);
    expect((await s.app.call("GET", "/api/internal/tls-ask?domain=other.example.com", local)).status).toBe(404);
    // a public (non-loopback) or unknown client never learns which hosts are active
    expect((await s.app.call("GET", "/api/internal/tls-ask?domain=shop.example.com", { headers: { "x-rt-client-ip": "198.51.100.7" } })).status).toBe(404);
    expect((await s.app.call("GET", "/api/internal/tls-ask?domain=shop.example.com")).status).toBe(404);
    expect((await s.app.fetch(new Request("http://localhost/api/internal/tls-ask?domain=shop.example.com"), { clientIp: "::1" })).status).toBe(200);
  });

  it("serves tls-ask 200 for <slug>.<apps host> only when the App exists", async () => {
    const s = await seed({ config: testConfig({ runtimePublicUrl: "https://apps.example.com" }) });
    await appIndexPut(s.db, { orgId: ORG.id, slug: APP.slug, serviceId: APP.serviceId });
    const ask = (d: string, ip = "127.0.0.1") => s.app.call("GET", `/api/internal/tls-ask?domain=${d}`, { headers: { "x-rt-client-ip": ip } });
    expect((await ask("shop.apps.example.com")).status).toBe(200);
    expect((await ask("SHOP.apps.example.com")).status).toBe(200);
    expect((await ask("nosuch.apps.example.com")).status).toBe(404);
    expect((await ask("a.shop.apps.example.com")).status).toBe(404);
    expect((await ask("apps.example.com")).status).toBe(404);
    expect((await ask("shop.example.com")).status).toBe(404);
    expect((await ask("shop.apps.example.com", "198.51.100.7")).status).toBe(404);
    // a deleted org's Apps no longer get certificates
    await s.db.run("UPDATE orgs SET deleted_at = 1 WHERE slug = 'acme'");
    expect((await ask("shop.apps.example.com")).status).toBe(404);
  });

  it("instance admins list every domain with its org", async () => {
    const s = await seed();
    await claim(s, "one.example.com");
    await s.db.run("UPDATE users SET instance_admin = 1 WHERE email = 'owner@acme.test'");
    const res = await s.owner.call("GET", "/api/admin/domains");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { host: string; org: { slug: string } }[] };
    expect(body.items).toEqual([expect.objectContaining({ host: "one.example.com", org: { slug: "acme", name: "Acme" } })]);
    expect((await s.dev.call("GET", "/api/admin/domains")).status).toBe(403);
  });
});
