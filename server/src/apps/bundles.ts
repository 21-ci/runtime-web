// App bundles: settings, env, data, blobs and sources in one file. A bundle holds env values and data, so making or
// reading one takes the export right. Importing takes create, deploy and the export right on the target project, the
// same as the runtime asks of a key, because the console's own key would otherwise pass on anyone's behalf.
// Big bundles belong to the CLI: the SDK's chunking caps what fits through here.

import { AppError, conflict, invalid, notFound } from "../http/errors.ts";
import { authorize } from "../orgs/members.ts";
import { rt } from "../runtime/errors.ts";
import type { CtlRes } from "../runtime/types.ts";
import { randomBytes, base64url } from "../crypto/random.ts";
import { appIndexPut } from "./index-table.ts";
import { appFor, EXPORT_CHUNK, type OrgCtx } from "./service.ts";
import { SLUG_RE } from "./slug.ts";

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ENV_RE = /^[a-z][a-z0-9-]{0,31}$/;
const DOWNLOAD_HOPS = 40;
/** 36 of the 50 fetches of a task once base64-encoded and cut into 150 KiB parts. */
export const MAX_IMPORT_BYTES = 4 << 20;

const path = (id: string, bundle: string) => `/v1/services/${encodeURIComponent(id)}/bundle/${encodeURIComponent(bundle)}`;
const failureCode = (f: unknown): string | null => {
  const code = (f as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : f ? "internal" : null;
};
const totalOf = (r: CtlRes) => {
  const m = /\/(\d+)\s*$/.exec(r.headers["content-range"] ?? "");
  return m ? Number(m[1]) : null;
};

export async function startBundle(c: OrgCtx, slug: string) {
  const app = await appFor(c, slug, "app.data.export");
  const b = await rt(() => c.cli.createBundle(app.id));
  return { id: b.id, state: b.state, bytes: b.bytes ?? null, expires_at: b.expires_at ?? null, failure: failureCode(b.failure) };
}

/** A ready bundle answers with its bytes, so one byte tells the state and the size without the transfer. */
export async function bundleState(c: OrgCtx, slug: string, id: string) {
  const app = await appFor(c, slug, "app.data.export");
  if (!ID_RE.test(id)) throw notFound();
  const res = await rt(() => c.cli.raw({ method: "GET", path: path(app.id, id), headers: { range: "bytes=0-0" } }));
  if ((res.headers["content-type"] ?? "").includes("zstd") || res.status === 206) {
    const bytes = totalOf(res);
    return { id, state: "ready", bytes, failure: null, too_large: bytes !== null && bytes > EXPORT_CHUNK * DOWNLOAD_HOPS };
  }
  const b = res.body as { state?: unknown; failure?: unknown } | null;
  return { id, state: String(b?.state ?? "running"), bytes: null, failure: failureCode(b?.failure), too_large: false };
}

function bytesOf(res: CtlRes): Uint8Array {
  if (typeof res.body !== "string") return new Uint8Array();
  return res.encoding === "base64" ? Uint8Array.from(atob(res.body), (ch) => ch.charCodeAt(0)) : new TextEncoder().encode(res.body);
}

export async function bundleBytes(c: OrgCtx, slug: string, id: string): Promise<Uint8Array> {
  const app = await appFor(c, slug, "app.data.export");
  if (!ID_RE.test(id)) throw notFound();
  const parts: Uint8Array[] = [];
  let off = 0;
  let total = 0;
  let tag = "";
  for (let i = 0; i < DOWNLOAD_HOPS; i++) {
    const headers: Record<string, string> = { range: `bytes=${off}-${off + EXPORT_CHUNK - 1}`, ...(tag ? { "if-range": tag } : {}) };
    const res = await rt(() => c.cli.raw({ method: "GET", path: path(app.id, id), headers }));
    if (!(res.headers["content-type"] ?? "").includes("zstd")) throw conflict("bundle_not_ready", "the bundle is not ready");
    const part = bytesOf(res);
    total = totalOf(res) ?? part.length;
    if (total > EXPORT_CHUNK * DOWNLOAD_HOPS) throw new AppError(413, "export_too_large", "the bundle is too large to download here", { cli: "21ci app export" });
    tag = res.headers["etag"] ?? tag;
    parts.push(part);
    off += part.length;
    if (off >= total || part.length === 0) break;
  }
  if (off < total) throw new AppError(502, "runtime_unavailable", "runtime unavailable");
  const out = new Uint8Array(off);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export interface ImportInput {
  slug: string;
  project: string;
  environment: string;
  activate: boolean;
  from?: string | undefined;
}

export function parseImport(q: URLSearchParams): ImportInput {
  const fields: Record<string, string> = {};
  const slug = q.get("slug") ?? "";
  const project = q.get("project") ?? "";
  const environment = q.get("environment") ?? "";
  if (!SLUG_RE.test(slug)) fields.slug = "pattern";
  if (!project) fields.project = "required";
  if (!ENV_RE.test(environment)) fields.environment = "pattern";
  if (Object.keys(fields).length) throw invalid(fields);
  const from = q.get("from") ?? undefined;
  return { slug, project, environment, activate: q.get("activate") === "1", from };
}

const toBase64 = (b: Uint8Array) => {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

/** Without bytes, `from` names an App of this org to fork; its data is read, so it takes the export right too. */
export async function importApp(c: OrgCtx, input: ImportInput, bytes: Uint8Array | null) {
  for (const a of ["app.create", "app.deploy", "app.data.export"] as const) authorize(c.sub, a, input.project);
  let fromId: string | undefined;
  if (input.from !== undefined) fromId = (await appFor(c, input.from, "app.data.export")).id;
  else if (!bytes || bytes.length === 0) throw invalid({ body: "required" });
  const out = await rt(() => c.cli.importBundle(
    { slug: input.slug, project: input.project, environment: input.environment, activate: input.activate ? true : undefined, from: fromId },
    base64url(randomBytes(16)),
    bytes && bytes.length && fromId === undefined ? toBase64(bytes) : undefined,
  ));
  await appIndexPut(c.deps.storage.db, { slug: input.slug, orgId: c.org.id, serviceId: out.service_id }).catch((e: unknown) => {
    // The backfill job fills a missed row in.
    console.error("apps: index after import", String(e));
  });
  return { slug: input.slug, warnings: out.warnings ?? [], missing_secrets: out.missing_secrets ?? [] };
}
