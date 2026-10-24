// Contract guard: every method + path row in docs/api-web.md must be a registered route,
// except the design §4 drops and routes owned by tasks not merged yet (skipped, listed).
// Doc placeholders `{x}` and the `…` prefix (= /api/orgs/{org}/apps/{app}) are normalised.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { testApp } from "./harness.ts";

const DOC = readFileSync(new URL("../../docs/api-web.md", import.meta.url), "utf8");

const APP_PREFIX = "/api/orgs/{org}/apps/{app}";

/** §4 and §9 of the design: the router routes are dropped on the runtime (no rtrouter). */
const DROPPED = new Set(["GET /api/internal/router/routes", "POST /api/internal/router/cert-status"]);

/** Owned by this task (must be registered). */
const MINE = [
  "/api/admin/domains",
  "/api/admin/audit",
  "/api/admin/settings",
  "/api/internal/tls-ask",
  "/api/orgs/:org/audit",
  "/api/orgs/:org/apps/:app/domains",
];

/**
 * Owned by tasks that have not merged yet (T5 orgs/users/invites, T6 keys/projects/node,
 * T7 apps). Skipped until their routes land; remove the entry when they do.
 */
const PENDING_OWNERS = [/^\/api\/orgs(\/|$)/, /^\/api\/admin\/(users|orgs|node)/, /^\/api\/(admin\/)?invites/];

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

const pathKey = (p: string) => keyOf("GET", p).slice(4);
const isMine = (path: string) => {
  const k = pathKey(path);
  return MINE.some((p) => k === pathKey(p) || k.startsWith(`${pathKey(p)}/`));
};

describe("docs/api-web.md contract", () => {
  const rows = parseDocRoutes(DOC);
  const registered = new Set(testApp().routes().map((r) => keyOf(r.method, r.pattern)));

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
    } else if (!isMine(row.path) && PENDING_OWNERS.some((re) => re.test(row.path))) {
      it.skip(`${name}: pending, owned by another task`, () => {});
    } else {
      it(`${name} is registered`, () => {
        expect(registered.has(key), `no route for ${key}`).toBe(true);
      });
    }
  }
});
