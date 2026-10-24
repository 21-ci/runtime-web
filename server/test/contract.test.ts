// Contract guard: every method + path row in docs/reference/api.md must be a registered route,
// except the design §4 drops (skipped, listed).
// Doc placeholders `{x}` and the `…` prefix (= /api/orgs/{org}/apps) are normalised.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testApp } from "./harness.ts";

const DOC = readFileSync(new URL("../../docs/reference/api.md", import.meta.url), "utf8");

const APP_PREFIX = "/api/orgs/{org}/apps";

/** Routes of the removed host router; kept so an old doc row is reported as dropped, not missing. */
const DROPPED = new Set(["GET /api/internal/router/routes", "POST /api/internal/router/cert-status"]);

export interface DocRoute {
  method: string;
  path: string;
}

/** Normalised key: `METHOD /path` with every parameter spelled `:p`. */
export const keyOf = (method: string, path: string) =>
  `${method.toUpperCase()} ${path.replace(/\?.*$/, "").replace(/\{[^}]+\}|:[^/]+/g, ":p").replace(/\/+$/, "") || "/"}`;

export function parseDocRoutes(doc: string): DocRoute[] {
  const out: DocRoute[] = [];
  for (const line of doc.split("\n")) {
    const m = /^\|\s*(GET|POST|PUT|PATCH|DELETE)\s*\|\s*`([^`]+)`/.exec(line);
    if (!m) continue;
    let path = (m[2] ?? "").trim();
    if (path.startsWith("…")) path = APP_PREFIX + path.slice(1);
    if (!path.startsWith("/api") && !path.startsWith("/healthz")) continue;
    out.push({ method: m[1] ?? "", path });
  }
  return out;
}

describe("docs/reference/api.md contract", () => {
  const rows = parseDocRoutes(DOC);
  // With an (empty) embedded console so the SPA module registers its routes too.
  const registered = new Set(testApp({ spa: { assets: {} } }).routes().map((r) => keyOf(r.method, r.pattern)));

  it("parses the endpoint tables", () => {
    expect(rows.length).toBeGreaterThanOrEqual(60);
  });

  // One test per doc row so each gap is named in the report.
  const seen = new Set<string>();
  for (const row of rows) {
    const key = keyOf(row.method, row.path);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = `${row.method} ${row.path}`;
    if (registered.has(key)) {
      it(`${name} is registered`, () => {
        expect(registered.has(key)).toBe(true);
      });
    } else if (DROPPED.has(key)) {
      it.skip(`${name}: dropped on the runtime (design §4)`, () => {});
    } else {
      it(`${name} is registered`, () => {
        expect(registered.has(key), `no route for ${key}`).toBe(true);
      });
    }
  }
});
