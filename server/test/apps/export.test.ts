import { describe, expect, it } from "vitest";
import { APPS, createApp, errOf, world } from "./helpers.ts";
import { csvCell, exportFileName, exportFormat, exportResponse, MAX_EXPORT_ROWS } from "../../src/http/export.ts";

async function auditRows(w: Awaited<ReturnType<typeof world>>, action: string) {
  return w.app.deps.storage.db.all<{ action: string; target: string; data: string; actor_id: string }>("SELECT action, target, data, actor_id FROM audit WHERE action = ?", [action]);
}

describe("export helpers", () => {
  it("quotes CSV cells and defuses spreadsheet formulas", () => {
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("-1+1")).toBe("'-1+1");
    expect(csvCell(null)).toBe("");
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"');
    expect(csvCell(-5)).toBe("-5");
  });

  it("parses the format against what the route allows", () => {
    const q = (s: string) => new URLSearchParams(s);
    expect(exportFormat(q(""), ["csv"])).toBeNull();
    expect(exportFormat(q("format=csv"), ["csv"])).toBe("csv");
    expect(() => exportFormat(q("format=xml"), ["csv"])).toThrow();
  });

  it("names files in UTC and strips header-unsafe characters", () => {
    expect(exportFileName(["acme", 'he"llo\r\n'], "logs", 0, Date.UTC(2026, 10, 6, 14), "txt")).toBe("acme-hello-logs-19700101T000000Z-20261106T140000Z.txt");
    expect(exportFileName(["acme"], "usage", null, Date.UTC(2026, 0, 1), "csv")).toBe("acme-usage-start-20260101T000000Z.csv");
  });

  it("caps the rows, marks the cut and stops pulling", async () => {
    let produced = 0;
    async function* rows() {
      for (;;) yield produced++;
    }
    const res = await exportResponse({ fileName: "x.ndjson", format: "ndjson", rows: rows(), line: (n) => JSON.stringify({ n }), maxRows: 3 });
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3] ?? "")).toEqual({ truncated: true, limit: 3 });
    expect(produced).toBeLessThanOrEqual(5);
    expect(MAX_EXPORT_ROWS).toBe(100_000);
  });

  it("surfaces a first-page failure before any response exists, and a later one as a broken stream", async () => {
    // eslint-disable-next-line require-yield
    async function* bad(): AsyncGenerator<number> {
      throw new Error("first");
    }
    await expect(exportResponse({ fileName: "x", format: "txt", rows: bad(), line: String })).rejects.toThrow("first");
    async function* late() {
      yield 1;
      throw new Error("later");
    }
    const res = await exportResponse({ fileName: "x", format: "txt", rows: late(), line: String });
    await expect(res.text()).rejects.toThrow("later");
  });

  it("releases the source when the client cancels", async () => {
    let closed = false;
    async function* rows() {
      try {
        for (;;) yield 1;
      } finally {
        closed = true;
      }
    }
    const res = await exportResponse({ fileName: "x", format: "txt", rows: rows(), line: String });
    await res.body?.cancel();
    expect(closed).toBe(true);
  });
});

describe("log export", () => {
  async function seeded() {
    const w = await world();
    const owner = await w.user("o@example.com", "owner");
    await createApp(owner);
    const id = [...w.fake.services.values()].find((s) => s.view.slug === "hello")?.view.id ?? "";
    w.fake.emitLog(id, "booted");
    w.fake.emitLog(id, "=cmd\nforged line", undefined, "warn");
    w.fake.emitLog(id, "broke", undefined, "error");
    return { w, owner, id };
  }

  it("streams ndjson with an attachment header and an audit entry", async () => {
    const { w, owner } = await seeded();
    const res = await owner.call("GET", `${APPS}/hello/logs?format=ndjson`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="acme-hello-logs-start-\d{8}T\d{6}Z\.ndjson"$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rows = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { msg: string; service_id?: string });
    expect(rows.map((r) => r.msg)).toEqual(["booted", "=cmd\nforged line", "broke"]);
    expect(rows[0]?.service_id).toBeUndefined();
    const entries = await auditRows(w, "app.logs.export");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.target).toBe("hello");
    expect(JSON.parse(entries[0]?.data ?? "{}")).toMatchObject({ format: "ndjson" });
  });

  it("writes one txt line per entry, so a message cannot forge a line", async () => {
    const { owner } = await seeded();
    const res = await owner.call("GET", `${APPS}/hello/logs?format=txt`);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const lines = (await res.text()).trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z WARN runtime =cmd\\nforged line$/);
  });

  it("applies the level as a minimum, like the live view, and forwards the range", async () => {
    const { w, owner } = await seeded();
    const since = "2026-01-01T00:00:00Z";
    const until = "2030-01-01T00:00:00Z";
    const res = await owner.call("GET", `${APPS}/hello/logs?format=ndjson&level=warn&kind=runtime&since=${since}&until=${until}`);
    const rows = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { level: string });
    expect(rows.map((r) => r.level)).toEqual(["warn", "error"]);
    const call = w.fake.calls.find((c) => c.path.endsWith("/logs") && (c as { query?: Record<string, unknown> }).query?.since === since);
    expect(call).toBeTruthy();
    expect(res.headers.get("content-disposition")).toContain("20260101T000000Z-20300101T000000Z.ndjson");
  });

  it("a range read is a view: no attachment, no audit entry, same filters", async () => {
    const { w, owner } = await seeded();
    const res = await owner.call("GET", `${APPS}/hello/logs?view=range&level=warn&since=2026-01-01T00:00:00Z`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(res.headers.get("content-disposition")).toBeNull();
    const rows = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { level: string });
    expect(rows.map((r) => r.level)).toEqual(["warn", "error"]);
    expect(await auditRows(w, "app.logs.export")).toHaveLength(0);
  });

  it("a range read ends one page with the truncation line, and the export of the same range is still audited", async () => {
    const { w, owner, id } = await seeded();
    for (let i = 0; i < 1200; i++) w.fake.emitLog(id, `n${i}`);
    const lines = (await (await owner.call("GET", `${APPS}/hello/logs?view=range`)).text()).trim().split("\n");
    expect(lines).toHaveLength(1001);
    expect(JSON.parse(lines[1000] ?? "")).toEqual({ truncated: true, limit: 1000 });
    await (await owner.call("GET", `${APPS}/hello/logs?format=ndjson`)).text();
    expect(await auditRows(w, "app.logs.export")).toHaveLength(1);
  });

  it("refuses an unknown view, a view with a format, and a view without the read right", async () => {
    const { w, owner } = await seeded();
    expect((await owner.call("GET", `${APPS}/hello/logs?view=nope`)).status).toBe(422);
    expect((await owner.call("GET", `${APPS}/hello/logs?view=range&format=txt`)).status).toBe(422);
    const outsider = await w.user("x@example.com", null);
    expect([403, 404]).toContain((await outsider.call("GET", `${APPS}/hello/logs?view=range`)).status);
  });

  it("pages past one runtime page", async () => {
    const { w, owner, id } = await seeded();
    for (let i = 0; i < 1200; i++) w.fake.emitLog(id, `n${i}`);
    const res = await owner.call("GET", `${APPS}/hello/logs?format=txt`);
    expect((await res.text()).trim().split("\n")).toHaveLength(1203);
  });

  it("rejects a bad format, level, kind or range and audits nothing", async () => {
    const { w, owner } = await seeded();
    for (const q of ["format=csv", "format=ndjson&level=loud", "format=txt&kind=nope", "format=txt&since=yesterday", "format=txt&until=2026-01-01"]) {
      expect((await owner.call("GET", `${APPS}/hello/logs?${q}`)).status, q).toBe(422);
    }
    expect(await auditRows(w, "app.logs.export")).toHaveLength(0);
  });

  it("needs app.logs.read and stays inside the org", async () => {
    const { w } = await seeded();
    const outsider = await w.user("x@example.com", null);
    const res = await outsider.call("GET", `${APPS}/hello/logs?format=ndjson`);
    expect([403, 404]).toContain(res.status);
    expect(await auditRows(w, "app.logs.export")).toHaveLength(0);
    expect((await w.admin.call("GET", `${APPS}/ghost/logs?format=txt`)).status).toBe(404);
  });

  it("leaves the live stream alone when no format is given", async () => {
    const { owner } = await seeded();
    const res = await owner.call("GET", `${APPS}/hello/logs`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.body?.cancel();
  });
});

describe("version and stats export", () => {
  it("exports versions as csv with the live flag and an audit entry", async () => {
    const w = await world();
    const owner = await w.user("o@example.com", "owner");
    await createApp(owner);
    const res = await owner.call("GET", `${APPS}/hello/versions?format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const lines = (await res.text()).trim().split("\r\n");
    expect(lines[0]).toBe("version,state,live,source_digest,author,created_at,failure,meta");
    expect(lines[1]).toMatch(/^1,[a-z]+,true,/);
    expect(await auditRows(w, "app.versions.export")).toHaveLength(1);
    expect(await errOf(await owner.call("GET", `${APPS}/hello/versions?format=ndjson`))).toMatchObject({ code: expect.any(String) });
  });

  it("still answers json without a format", async () => {
    const w = await world();
    await createApp(w.admin);
    expect(await (await w.admin.call("GET", `${APPS}/hello/versions`)).json()).toMatchObject({ items: [{ version: 1 }] });
  });

  it("exports stats as csv: the series when there is one, and validates the window", async () => {
    const w = await world();
    const owner = await w.user("o@example.com", "owner");
    await createApp(owner);
    const week = await owner.call("GET", `${APPS}/hello/stats?window=7d&format=csv`);
    expect(week.status).toBe(200);
    expect((await week.text()).split("\r\n")[0]).toBe("window,ts,count,errors");
    const hour = await owner.call("GET", `${APPS}/hello/stats?window=1h&format=csv`);
    expect(hour.status).toBe(200);
    const lines = (await hour.text()).trim().split("\r\n");
    expect(lines[0]).toBe("window,requests,errors,error_rate,p50_ms,p95_ms,p99_ms");
    expect(lines[1]).toMatch(/^1h,7,1,/);
    expect((await owner.call("GET", `${APPS}/hello/stats?window=9y&format=csv`)).status).toBe(422);
    expect(await auditRows(w, "app.stats.export")).toHaveLength(2);
  });
});
