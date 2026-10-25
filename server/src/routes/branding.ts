// Instance branding (api-web §6.1). The read routes are public: the login page renders the
// brand before anyone signs in, and the view holds display fields only. Writes are
// instance-admin, need If-Match (409 stale on a newer brand) and are audited with the change.

import type { Deps } from "../app.ts";
import { auditStmt } from "../audit/audit.ts";
import { authOf, requireAdmin } from "../auth/middleware.ts";
import { dbOf } from "../auth/types.ts";
import { isAssetKind, MAX_ASSET_BYTES, sniff, unsafeSvg, type AssetKind } from "../branding/assets.ts";
import { brandingView, fieldsStmt, getBranding, parseFields, resetStmts, themeCss, type Branding } from "../branding/service.ts";
import { sha256Hex } from "../crypto/hash.ts";
import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import { json, readJson } from "../http/json.ts";
import type { RequestContext, Router } from "../http/router.ts";
import type { Stmt } from "../storage/types.ts";

const IMMUTABLE = "public, max-age=31536000, immutable";
// SVG opened directly must not run script or load anything; inline styles are how most
// exported SVGs paint.
const SVG_CSP = "sandbox; default-src 'none'; style-src 'unsafe-inline'";

const quoted = (e: string) => `"${e}"`;

function viewResponse(b: Branding, status = 200): Response {
  return json(brandingView(b), status, { etag: quoted(b.etag) });
}

/** If-Match is required; a mismatch is 409 stale. */
function checkIfMatch(ctx: RequestContext, b: Branding): void {
  const got = (ctx.req.headers.get("if-match") ?? "").trim().replace(/^W\//, "").replace(/"/g, "");
  if (!got) throw new AppError(428, "precondition_required", "If-Match header required");
  if (got !== b.etag) throw conflict("stale", "changed elsewhere, reload");
}

const notModified = (ctx: RequestContext, etag: string) =>
  (ctx.req.headers.get("if-none-match") ?? "").split(",").some((t) => t.trim().replace(/^W\//, "") === etag);

function decodeBase64(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function kindOf(ctx: RequestContext): AssetKind {
  const k = ctx.params.kind ?? "";
  if (!isAssetKind(k)) throw notFound();
  return k;
}

export function registerBranding(r: Router, deps: Deps): void {
  const audited = (ctx: RequestContext, action: string, detail: unknown): Stmt =>
    auditStmt(deps, { actor: { userId: authOf(ctx).user.id, asInstanceAdmin: true }, action, target: "instance", detail });

  r.get("/api/branding", async () => viewResponse(await getBranding(await dbOf(deps))));

  r.get("/api/branding/theme.css", async (ctx) => {
    const b = await getBranding(await dbOf(deps));
    const etag = quoted(b.etag);
    const headers = { "content-type": "text/css; charset=utf-8", "cache-control": "no-cache", etag };
    if (notModified(ctx, etag)) return new Response(null, { status: 304, headers });
    return new Response(ctx.req.method === "HEAD" ? null : themeCss(b.fields), { headers });
  });

  r.get("/api/branding/assets/:kind", async (ctx) => {
    const kind = kindOf(ctx);
    const db = await dbOf(deps);
    const row = await db.first<{ mime: string; data: string; hash: string }>(
      "SELECT mime, data, hash FROM branding_assets WHERE kind = ?",
      [kind],
    );
    if (!row) throw notFound();
    const etag = quoted(row.hash);
    const v = ctx.url.searchParams.get("v");
    const headers: Record<string, string> = {
      "content-type": row.mime,
      "cache-control": v && row.hash.startsWith(v) ? IMMUTABLE : "no-cache",
      etag,
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    };
    if (row.mime === "image/svg+xml") headers["content-security-policy"] = SVG_CSP;
    if (notModified(ctx, etag)) return new Response(null, { status: 304, headers });
    const bytes = decodeBase64(row.data) ?? new Uint8Array();
    return new Response(ctx.req.method === "HEAD" ? null : (bytes as Uint8Array<ArrayBuffer>), { headers });
  });

  r.put(
    "/api/admin/branding",
    requireAdmin(deps, async (ctx) => {
      const body = await readJson<Record<string, unknown>>(ctx.req);
      const db = await dbOf(deps);
      const cur = await getBranding(db);
      checkIfMatch(ctx, cur);
      const next = parseFields(body, cur.fields);
      const changed = Object.keys(next).filter((k) => next[k as keyof typeof next] !== cur.fields[k as keyof typeof next]);
      await db.batch([fieldsStmt(next), audited(ctx, "branding.update", { fields: changed })]);
      return viewResponse(await getBranding(db));
    }),
  );

  r.delete(
    "/api/admin/branding",
    requireAdmin(deps, async (ctx) => {
      const db = await dbOf(deps);
      checkIfMatch(ctx, await getBranding(db));
      await db.batch([...resetStmts(), audited(ctx, "branding.reset", {})]);
      return viewResponse(await getBranding(db));
    }),
  );

  r.put(
    "/api/admin/branding/assets/:kind",
    requireAdmin(deps, async (ctx) => {
      const kind = kindOf(ctx);
      const body = await readJson<Record<string, unknown>>(ctx.req);
      const db = await dbOf(deps);
      checkIfMatch(ctx, await getBranding(db));
      const raw = typeof body.data === "string" ? body.data : "";
      const bytes = decodeBase64(raw);
      if (!raw || !bytes || bytes.length === 0) throw invalid({ data: "must_be_base64" });
      if (bytes.length > MAX_ASSET_BYTES) throw new AppError(413, "too_large", "image larger than 512 KB");
      const mime = sniff(bytes);
      if (!mime) throw invalid({ data: "unsupported_image" });
      if (mime === "image/svg+xml") {
        const why = unsafeSvg(bytes);
        if (why) throw invalid({ data: why });
      }
      const hash = (await sha256Hex(bytes)).slice(0, 32);
      await db.batch([
        {
          sql: `INSERT INTO branding_assets (kind, mime, data, hash, size, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(kind) DO UPDATE SET mime = excluded.mime, data = excluded.data, hash = excluded.hash,
                size = excluded.size, updated_at = excluded.updated_at`,
          args: [kind, mime, raw, hash, bytes.length, deps.now()],
        },
        audited(ctx, "branding.asset_update", { kind, mime, size: bytes.length }),
      ]);
      return viewResponse(await getBranding(db));
    }),
  );

  r.delete(
    "/api/admin/branding/assets/:kind",
    requireAdmin(deps, async (ctx) => {
      const kind = kindOf(ctx);
      const db = await dbOf(deps);
      checkIfMatch(ctx, await getBranding(db));
      await db.batch([
        { sql: "DELETE FROM branding_assets WHERE kind = ?", args: [kind] },
        audited(ctx, "branding.asset_delete", { kind }),
      ]);
      return viewResponse(await getBranding(db));
    }),
  );
}
